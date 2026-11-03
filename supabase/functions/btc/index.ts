// BTC whales from Blockchain.com's public API (https://www.blockchain.com/explorer/docs).
// There is no "rich list" endpoint and the site's pages may not be scraped, so the list is built from
// the chain itself:
//   1. Discovery: every third new block is read (/rawblock); addresses that send or receive ≥ 100 BTC in
//      one output are candidates. Their balances are read (/balance?active=a|b|…) and those holding
//      ≥ 1,000 BTC join the pool (table btc_whale_pool, private).
//   2. Daily snapshot (after 00:07 UTC): the balance of every pool address, ranked; the 100 largest are
//      stored like the other coins (holder_bands / holder_daily / holder_snapshot, token "BTC"), so Holder
//      Flow, Gem Radar and the confluence list pick BTC up on their own.
// Limits: dormant wallets never move, so they are not found (they would add nothing to the flows);
// exchange wallets are not labelled for BTC. Calls are spaced ≥ 10 s apart, as the docs ask.
// A key (secret BLOCKCHAIN_API_KEY, any case) is sent only when its header name is set in
// BLOCKCHAIN_KEY_HEADER; without it the free default limits apply.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const envAll = Deno.env.toObject();
const KEY_NAME = Object.keys(envAll).find((k) => /^blockchain_api_key$/i.test(k));
const API_KEY = (KEY_NAME ? envAll[KEY_NAME] : "").trim();
const KEY_HEADER = (envAll.BLOCKCHAIN_KEY_HEADER ?? "").trim();
const API = "https://blockchain.info";

const RUN_BUDGET_MS = 120_000, GAP_MS = 10_500;
const BIG_OUTPUT_SAT = 100 * 1e8, POOL_MIN_BTC = 1000, TOP = 100;
const BLOCK_EVERY = 3, SEED_BLOCKS = 144;   // read 1 block in 3; on the first run start ~1 day back
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["1-100", 1, 100]];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => { let m = e instanceof Error ? e.message : String(e); if (API_KEY.length > 8) m = m.split(API_KEY).join("***"); return m.slice(0, 200); };
let deadline = Infinity, lastCall = 0;
const timeLeft = () => deadline - Date.now();

// One request at a time, at least GAP_MS apart
async function api(path: string, ms = 40000) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const headers: Record<string, string> = {};
  if (API_KEY && KEY_HEADER) headers[KEY_HEADER] = API_KEY;
  const r = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(ms) });
  if (r.status !== 200) throw new Error(`blockchain.info ${r.status} ${(await r.text().catch(() => "")).slice(0, 100)}`);
  return await r.json();
}
async function loadState(key: string) {
  const { data } = await db.from("collector_state").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? {}) as Record<string, any>;
}
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

// Balances (BTC) of up to 50 addresses per call
async function balances(addrs: string[]) {
  const out = new Map<string, number>();
  for (let i = 0; i < addrs.length && timeLeft() > GAP_MS + 15000; i += 50) {
    const part = addrs.slice(i, i + 50);
    const j = await api(`/balance?active=${part.join("|")}`);
    for (const a of part) if (j?.[a] && Number.isFinite(+j[a].final_balance)) out.set(a, +j[a].final_balance / 1e8);
  }
  return out;
}

// ---------------- discovery ----------------
async function discover(result: Record<string, unknown>) {
  const st = await loadState("btc_discover");
  const latest = await api("/latestblock");
  const tip = +latest.height;
  let h = st.height ? +st.height : tip - SEED_BLOCKS;
  const cands = new Map<string, number>();
  let blocks = 0;
  while (h < tip && timeLeft() > 45000) {
    h += BLOCK_EVERY;
    if (h > tip) { h = tip; }
    const j = await api(`/block-height/${h}?format=json`, 60000);
    const blk = j?.blocks?.[0];
    if (!blk) break;
    for (const tx of blk.tx ?? []) {
      for (const o of tx.out ?? []) if (o.addr && +o.value >= BIG_OUTPUT_SAT) cands.set(o.addr, Math.max(cands.get(o.addr) ?? 0, +o.value / 1e8));
      for (const i of tx.inputs ?? []) { const p = i.prev_out; if (p?.addr && +p.value >= BIG_OUTPUT_SAT) cands.set(p.addr, Math.max(cands.get(p.addr) ?? 0, +p.value / 1e8)); }
    }
    blocks++;
  }
  // New candidates: balance check; known ones are refreshed by the daily snapshot
  const addrs = [...cands.keys()];
  const { data: known } = addrs.length ? await db.from("btc_whale_pool").select("address").in("address", addrs) : { data: [] };
  const knownSet = new Set((known ?? []).map((r) => r.address));
  const fresh = addrs.filter((a) => !knownSet.has(a));
  const bal = await balances(fresh);
  const rows = [...bal].map(([address, balance]) => ({ address, balance, checked_at: new Date().toISOString(), seen_btc: cands.get(address) }));
  if (rows.length) { const { error } = await db.from("btc_whale_pool").upsert(rows); if (error) throw error; }
  await saveState("btc_discover", { height: h, tip, at: new Date().toISOString() });
  const { count } = await db.from("btc_whale_pool").select("address", { count: "exact", head: true }).gte("balance", POOL_MIN_BTC);
  result.discover = { blocks, height: h, tip, candidates: addrs.length, checked: bal.size, unchecked: fresh.length - bal.size, whales_1000: rows.filter((r) => r.balance >= POOL_MIN_BTC).length, pool: count };
}

// ---------------- daily snapshot ----------------
type Prev = { wallet: string; balance: number; rank: number }[];
type Ranked = [string, number][];
function gini(xs: number[]) {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
}
// Same method as the other coins: yesterday's members of a band, their balance today minus yesterday
function bandRows(day: string, ranked: Ranked, prev: Prev, now: Map<string, number>) {
  const prevMap = new Map(prev.map((p) => [p.wallet, p]));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const cur = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; const t = now.get(p.wallet); if (t === undefined) left++; net += (t ?? p.balance) - p.balance; }
    }
    return { token: "BTC", day, band, balance: cur.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? cur.filter(([w]) => !prevMap.has(w)).length : null };
  });
}
async function snapshot(day: string, result: Record<string, unknown>) {
  const { data: done } = await db.from("holder_daily").select("day").eq("token", "BTC").eq("day", day);
  if (done?.length) { result.snapshot = "done today"; return; }
  const { data: pool } = await db.from("btc_whale_pool").select("address,balance").gte("balance", POOL_MIN_BTC * 0.5);
  const { data: prevRows } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", "BTC");
  const prev = (prevRows ?? []).filter((p) => p.day < day);
  // Today's balances: the pool plus yesterday's top 100 (so a wallet that dropped out counts exactly)
  const want = [...new Set([...(pool ?? []).map((r) => r.address), ...prev.map((p) => p.wallet)])];
  if (want.length < 20) { result.snapshot = `waiting: pool has ${want.length} addresses`; return; }
  const st = await loadState("btc_snapshot");
  const got: Record<string, number> = st.day === day ? st.got ?? {} : {};
  const todo = want.filter((a) => !(a in got));
  const bal = await balances(todo);
  for (const [a, b] of bal) got[a] = b;
  await saveState("btc_snapshot", { day, got });
  const left = want.filter((a) => !(a in got)).length;
  if (left) { result.snapshot = `${Object.keys(got).length}/${want.length} balances read, continuing next call`; return; }
  const now = new Map(Object.entries(got));
  const ranked: Ranked = [...now].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, TOP);
  const px = await fetch("https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT", { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
  const bands = bandRows(day, ranked, prev, now);
  let { error } = await db.from("holder_bands").upsert(bands);
  if (error) throw error;
  ({ error } = await db.from("holder_daily").upsert({ token: "BTC", day, price: px?.price ? +px.price : null, holders: null, top10_pct: null, top100_pct: null,
    gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: "blockchain.com (cá voi tự phát hiện)", depth: ranked.length }));
  if (error) throw error;
  ({ error } = await db.from("holder_snapshot").delete().eq("token", "BTC"));
  if (error) throw error;
  ({ error } = await db.from("holder_snapshot").insert(ranked.map(([wallet, balance], i) => ({ token: "BTC", wallet, balance, rank: i + 1, day, exchange: null }))));
  if (error) throw error;
  // Keep the pool's balances current too
  await db.from("btc_whale_pool").upsert([...now].map(([address, balance]) => ({ address, balance, checked_at: new Date().toISOString() })));
  result.snapshot = { top: ranked.length, compared: prev.length > 0, top1: Math.round(ranked[0]?.[1] ?? 0), net_1_100: bands.find((b) => b.band === "1-100")?.net ?? null };
}

// ---------------- profitable days ----------------
// Daily price history from the official charts API (one call a day), then for each day the share of
// all earlier trading days (price > 0) with a lower price: "if you had bought on a random earlier day,
// would you be in profit on this day?"
async function profitableDays(day: string, result: Record<string, unknown>) {
  const st = await loadState("btc_profitable");
  if (st.day === day) return;
  // Charts live on api.blockchain.info; same spacing rule as the other calls
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const x = await fetch("https://api.blockchain.info/charts/market-price?timespan=all&format=json&sampled=false", { signal: AbortSignal.timeout(60000) });
  if (x.status !== 200) throw new Error(`charts ${x.status}`);
  const r = await x.json();
  const vals = (r?.values ?? []).map((v: any) => ({ day: new Date(+v.x * 1000).toISOString().slice(0, 10), price: +v.y })).filter((v: any) => v.price > 0);
  if (vals.length < 1000) throw new Error(`charts: only ${vals.length} prices`);
  // The charts API lags a few days: the days after its last one come from Binance daily closes (UTC)
  const lastDay = vals[vals.length - 1].day;
  const k = await fetch("https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=15", { signal: AbortSignal.timeout(15000) }).then((x) => x.json()).catch(() => null);
  if (Array.isArray(k)) for (const c of k) { const d = new Date(c[0]).toISOString().slice(0, 10); if (d > lastDay && d < day) vals.push({ day: d, price: +c[4] }); }
  // Share of earlier days with a lower price: a sorted array of earlier prices, binary search per day
  const sorted: number[] = [], rows: { day: string; price: number; profitable_pct: number | null }[] = [];
  for (const v of vals) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v.price) lo = m + 1; else hi = m; }
    rows.push({ day: v.day, price: v.price, profitable_pct: sorted.length ? 100 * lo / sorted.length : null });
    sorted.splice(lo, 0, v.price);
  }
  for (let i = 0; i < rows.length; i += 1000) { const { error } = await db.from("btc_profitable_daily").upsert(rows.slice(i, i + 1000)); if (error) throw error; }
  await saveState("btc_profitable", { day, rows: rows.length, last: rows[rows.length - 1] });
  result.profitable = { rows: rows.length, last: rows[rows.length - 1] };
}

// Only pg_cron may start a run (shared secret in Supabase Vault, checked by cron_secret_ok)
async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  deadline = started + RUN_BUDGET_MS;
  const lock = await loadState("btc_lock");
  if (lock.at && Date.now() - Date.parse(lock.at) < 150000) return Response.json({ ok: false, skipped: "busy" });
  await saveState("btc_lock", { at: new Date().toISOString() });
  const day = new Date().toISOString().slice(0, 10);
  const result: Record<string, unknown> = { key: API_KEY ? (KEY_HEADER ? "sent" : "saved, header name not set: free limits") : "none: free limits" };
  try {
    try { await profitableDays(day, result); } catch (e) { result.profitable_error = errMsg(e); }
    // The daily snapshot comes first once the UTC day has started; discovery uses the rest of the time
    if (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() >= 7) { try { await snapshot(day, result); } catch (e) { result.snapshot_error = errMsg(e); } }
    if (timeLeft() > 50000) { try { await discover(result); } catch (e) { result.discover_error = errMsg(e); } }
  } finally {
    await saveState("btc_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
    await saveState("btc_lock", { at: null });
  }
  return Response.json({ ok: true, ms: Date.now() - started, result });
});

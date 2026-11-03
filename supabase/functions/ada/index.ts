// ADA holders from Blockfrost (https://docs.blockfrost.io). There is no rich-list endpoint, so the list
// is built from staking: most large ADA holders delegate, and Blockfrost lists every pool's delegators
// with their live stake.
//   1. Scan (repeated every 7 days): every pool with ≥ 5M ADA live stake, page by page through its
//      delegators; stake accounts with ≥ 5M ADA go into ada_whale_pool (private).
//   2. Daily snapshot (after 00:07 UTC, once a full scan exists): each pool account's controlled amount
//      (/accounts/{stake}), ranked; the top 1,000 stored like the other coins (token "ADA").
// Limits: wallets that do not stake are missed; no exchange labels. Free plan: 50,000 requests a day,
// 10 a second: this function stays under 40,000 a day and about 6 a second.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const envAll = Deno.env.toObject();
const KEY = (envAll[Object.keys(envAll).find((k) => /blockfrost/i.test(k)) ?? ""] ?? "").trim();
const API = "https://cardano-mainnet.blockfrost.io/api/v0";
const RUN_BUDGET_MS = 120_000, GAP_MS = 170, DAY_CAP = 40_000;
const MIN_ADA = 5_000_000, TOP = 1000, RESCAN_DAYS = 7;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => { let m = e instanceof Error ? e.message : String(e); if (KEY.length > 8) m = m.split(KEY).join("***"); return m.slice(0, 200); };
let deadline = Infinity, lastCall = 0, usage = { day: "", calls: 0 };
const timeLeft = () => deadline - Date.now();
class Stop extends Error {}

async function bf(path: string) {
  if (usage.calls >= DAY_CAP) throw new Stop("daily request cap reached");
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now(); usage.calls++;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`${API}${path}`, { headers: { project_id: KEY }, signal: AbortSignal.timeout(30000) });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (r.status === 404) return null;
    if (r.status === 402 || r.status === 403) throw new Stop(`blockfrost ${r.status}: plan limit or key`);
    if (r.status !== 200) throw new Error(`blockfrost ${r.status} ${(await r.text().catch(() => "")).slice(0, 100)}`);
    return await r.json();
  }
  throw new Stop("blockfrost 429: rate limited");
}
async function loadState(key: string) {
  const { data } = await db.from("collector_state").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? {}) as Record<string, any>;
}
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

// ---------------- scan of pool delegators ----------------
async function scan(st: Record<string, any>, result: Record<string, unknown>) {
  if (!st.pools || (st.done && Date.now() - Date.parse(st.done_at) > RESCAN_DAYS * 864e5)) {
    // Pool list (100 per page), keeping pools large enough to hold a whale
    const pools: string[] = [];
    let complete = false;
    for (let page = 1; page < 200 && timeLeft() > 20000; page++) {
      const list = await bf(`/pools/extended?count=100&page=${page}`);
      if (!Array.isArray(list)) break;
      for (const p of list) if (+p.live_stake / 1e6 >= MIN_ADA) pools.push(p.pool_id);
      if (list.length < 100) { complete = true; break; }
    }
    if (!complete) { result.scan = "pool list not finished, continuing next call"; return; }
    Object.assign(st, { pools, pool_i: 0, page: 1, found: 0, done: false, started_at: new Date().toISOString() });
  }
  if (st.done) return;
  const rows: { stake: string; live_stake: number; seen_at: string }[] = [];
  while (st.pool_i < st.pools.length && timeLeft() > 15000) {
    const id = st.pools[st.pool_i];
    const list = await bf(`/pools/${id}/delegators?count=100&page=${st.page}`);
    if (Array.isArray(list)) for (const d of list) { const ada = +d.live_stake / 1e6; if (ada >= MIN_ADA && typeof d.address === "string") rows.push({ stake: d.address, live_stake: ada, seen_at: new Date().toISOString() }); }
    if (!Array.isArray(list) || list.length < 100) { st.pool_i++; st.page = 1; } else st.page++;
  }
  if (rows.length) { const { error } = await db.from("ada_whale_pool").upsert(rows); if (error) throw error; st.found += rows.length; }
  if (st.pool_i >= st.pools.length) { st.done = true; st.done_at = new Date().toISOString(); st.ever_done = true; }
  result.scan = { pools: st.pools.length, pool_i: st.pool_i, found_this_scan: st.found, done: !!st.done };
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
function bandRows(day: string, ranked: Ranked, prev: Prev, now: Map<string, number>) {
  const cutoff = ranked[ranked.length - 1][1], prevMap = new Map(prev.map((p) => [p.wallet, p])), top = new Set(ranked.map(([w]) => w));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const cur = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) { net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; if (!top.has(p.wallet)) left++; net += (now.get(p.wallet) ?? Math.min(cutoff, p.balance)) - p.balance; } }
    return { token: "ADA", day, band, balance: cur.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? cur.filter(([w]) => !prevMap.has(w)).length : null };
  });
}
async function snapshot(day: string, scanState: Record<string, any>, result: Record<string, unknown>) {
  if (!scanState.ever_done) { result.snapshot = "waiting for the first full scan"; return; }
  const { data: done } = await db.from("holder_daily").select("day").eq("token", "ADA").eq("day", day);
  if (done?.length) { result.snapshot = "done today"; return; }
  const { data: pool } = await db.from("ada_whale_pool").select("stake").order("live_stake", { ascending: false }).limit(2500);
  const { data: prevRows } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", "ADA");
  const prev = (prevRows ?? []).filter((p) => p.day < day);
  const want = [...new Set([...(pool ?? []).map((r) => r.stake), ...prev.map((p) => p.wallet)])];
  const st = await loadState("ada_snapshot");
  const got: Record<string, number> = st.day === day ? st.got ?? {} : {};
  try {
    for (const a of want) {
      if (a in got) continue;
      if (timeLeft() < 15000) break;
      const acc = await bf(`/accounts/${a}`);
      got[a] = acc ? +acc.controlled_amount / 1e6 : 0;
    }
  } finally { await saveState("ada_snapshot", { day, got }); }
  const left = want.filter((a) => !(a in got)).length;
  if (left) { result.snapshot = `${want.length - left}/${want.length} accounts read, continuing next call`; return; }
  const now = new Map(Object.entries(got));
  const ranked: Ranked = [...now].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, TOP);
  if (ranked.length < 10) { result.snapshot = "too few accounts"; return; }
  const px = await fetch("https://data-api.binance.vision/api/v3/ticker/price?symbol=ADAUSDT", { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
  const bands = bandRows(day, ranked, prev, now);
  let { error } = await db.from("holder_bands").upsert(bands);
  if (error) throw error;
  ({ error } = await db.from("holder_daily").upsert({ token: "ADA", day, price: px?.price ? +px.price : null, holders: null, top10_pct: null, top100_pct: null,
    gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: "blockfrost (ví đang stake ≥ 5 triệu ADA)", depth: ranked.length }));
  if (error) throw error;
  ({ error } = await db.from("holder_snapshot").delete().eq("token", "ADA"));
  if (error) throw error;
  for (let i = 0; i < ranked.length; i += 500) {
    ({ error } = await db.from("holder_snapshot").insert(ranked.slice(i, i + 500).map(([wallet, balance], j) => ({ token: "ADA", wallet, balance, rank: i + j + 1, day, exchange: null }))));
    if (error) throw error;
  }
  result.snapshot = { top: ranked.length, compared: prev.length > 0, top1: Math.round(ranked[0][1]), net_1_100: bands.find((b) => b.band === "1-100")?.net ?? null };
}

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!KEY) { await saveState("ada_status", { at: new Date().toISOString(), result: { error: "no BLOCKFROST_PROJECT_ID secret" } }); return Response.json({ ok: false, error: "no key" }); }
  const started = Date.now(), day = new Date().toISOString().slice(0, 10);
  deadline = started + RUN_BUDGET_MS;
  const lock = await loadState("ada_lock");
  if (lock.at && Date.now() - Date.parse(lock.at) < 150000) return Response.json({ ok: false, skipped: "busy" });
  await saveState("ada_lock", { at: new Date().toISOString() });
  const u = await loadState("ada_usage");
  usage = { day, calls: u.day === day ? +u.calls || 0 : 0 };
  const result: Record<string, unknown> = {};
  const st = await loadState("ada_scan");
  try {
    // The daily snapshot first once the UTC day has started; the scan uses the rest of the time
    if (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() >= 7) { try { await snapshot(day, st, result); } catch (e) { result.snapshot_error = errMsg(e); } }
    if (timeLeft() > 20000) { try { await scan(st, result); } catch (e) { result.scan_error = errMsg(e); } }
  } finally {
    await saveState("ada_scan", st);
    await saveState("ada_usage", usage);
    await saveState("ada_status", { at: new Date().toISOString(), ms: Date.now() - started, calls_today: usage.calls, result });
    await saveState("ada_lock", { at: null });
  }
  return Response.json({ ok: true, result });
});

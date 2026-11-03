// Sui holders from Sui's public GraphQL (https://graphql.mainnet.sui.io/graphql), free:
// - SUI: every StakedSui object (owner + principal) is listed by type; principals are summed per owner.
//   Most large SUI holders stake, so the stakers are the whale pool. Daily: each pool address's liquid
//   SUI + its StakedSui principals.
// - Sui tokens (coins of the radar's top 200 whose main supply is on Sui): every Coin<T> object is
//   listed by type with its owner and balance, so the whole holder list is summed per owner. Coins held
//   by objects or shared objects (pools, vaults) are left out: only address owners count.
// Scans run once a week per token, resumed across calls; the daily snapshot (after 00:07 UTC) reads
// the pool's balances and stores the top 1,000 like the other coins (holder_bands / holder_daily /
// holder_snapshot). Calls are spaced ~0.4 s apart (the public endpoint is rate limited).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const GQL = "https://graphql.mainnet.sui.io/graphql";
const RUN_BUDGET_MS = 120_000, GAP_MS = 400, RESCAN_DAYS = 7, POOL = 1500, TOP = 1000, UNI_DAYS = 7;
const SUI_TYPE = "0x2::sui::SUI", STAKED = "0x3::staking_pool::StakedSui";
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let deadline = Infinity, lastCall = 0;
const timeLeft = () => deadline - Date.now();
async function gql(query: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastCall + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await fetch(GQL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30000) });
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    const j = await r.json().catch(() => null);
    if (r.status !== 200 || !j || j.errors?.length) throw new Error(`sui graphql ${r.status} ${JSON.stringify(j?.errors?.[0]?.message ?? "").slice(0, 140)}`);
    return j.data;
  }
  throw new Error("sui graphql: rate limited");
}
async function loadState(key: string) {
  const { data } = await db.from("collector_state").select("value").eq("key", key).maybeSingle();
  return (data?.value ?? {}) as Record<string, any>;
}
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });
const qs = (s: string) => JSON.stringify(s);

type Tok = { sym: string; type: string; decimals: number; mode: "stake" | "coins" };

// ---------------- which tokens ----------------
// The radar's top 200 coins whose CoinGecko platform list has a Sui coin type holding ≥ 50% of the
// coin's total supply (so a bridged copy is never taken for the coin). Rebuilt once a week.
async function buildUniverse(): Promise<Tok[]> {
  const toks: Tok[] = [{ sym: "SUI", type: SUI_TYPE, decimals: 9, mode: "stake" }];
  const { data: last } = await db.from("momentum_daily").select("day").order("day", { ascending: false }).limit(1);
  const { data: rad } = await db.from("momentum_daily").select("token").eq("day", last?.[0]?.day ?? "").lte("rank", 200);
  const want = new Set((rad ?? []).map((r) => String(r.token)));
  const markets: any[] = [];
  for (const page of [1, 2]) {
    const r = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`, { signal: AbortSignal.timeout(30000) });
    if (r.status !== 200) break; markets.push(...await r.json()); await sleep(2500);
  }
  const lr = await fetch("https://api.coingecko.com/api/v3/coins/list?include_platform=true", { signal: AbortSignal.timeout(60000) });
  if (lr.status !== 200) throw new Error(`coingecko list ${lr.status}`);
  const plat = new Map((await lr.json() as any[]).map((c) => [c.id, c.platforms ?? {}]));
  for (const m of markets) {
    const sym = String(m.symbol).toUpperCase();
    if (sym === "SUI" || !want.has(sym)) continue;
    const t = plat.get(m.id)?.sui;
    if (typeof t !== "string" || !t.includes("::")) continue;
    try {
      const d = await gql(`{ coinMetadata(coinType: ${qs(t)}) { decimals supply } }`);
      const dec = +d?.coinMetadata?.decimals, supply = Number(d?.coinMetadata?.supply ?? 0) / 10 ** dec;
      const ref = +m.total_supply || +m.circulating_supply || 0;
      if (Number.isFinite(dec) && ref && supply >= 0.5 * ref) toks.push({ sym, type: t, decimals: dec, mode: "coins" });
    } catch { /* metadata unavailable: skipped this week */ }
  }
  return toks;
}

// ---------------- scans ----------------
async function scan(toks: Tok[], st: Record<string, any>, result: Record<string, unknown>) {
  // The token whose last finished scan is oldest (or that never finished) goes next
  st.scans ??= {};
  const due = toks.filter((t) => !st.scans[t.sym]?.done_at || Date.now() - Date.parse(st.scans[t.sym].done_at) > RESCAN_DAYS * 864e5 || st.scans[t.sym]?.cursor)
    .sort((a, b) => (st.scans[a.sym]?.cursor ? -1 : 0) - (st.scans[b.sym]?.cursor ? -1 : 0) || Date.parse(st.scans[a.sym]?.done_at ?? 0) - Date.parse(st.scans[b.sym]?.done_at ?? 0));
  const t = due[0];
  if (!t) { result.scan = "all scans fresh"; return; }
  const s = st.scans[t.sym] ?? {};
  if (!s.cursor && !s.running) { s.running = new Date().toISOString().slice(0, 19); s.objects = 0; }
  const type = t.mode === "stake" ? STAKED : `0x2::coin::Coin<${t.type}>`;
  let pages = 0;
  while (timeLeft() > 12000) {
    const d = await gql(`{ objects(first: 50, ${s.cursor ? `after: ${qs(s.cursor)}, ` : ""}filter: { type: ${qs(type)} }) { nodes { owner { __typename ... on AddressOwner { address { address } } } asMoveObject { contents { json } } } pageInfo { hasNextPage endCursor } } }`);
    const o = d?.objects, sums = new Map<string, number>();
    for (const n of o?.nodes ?? []) {
      const a = n?.owner?.__typename === "AddressOwner" ? n.owner.address?.address : null;
      const j = n?.asMoveObject?.contents?.json;
      const raw = t.mode === "stake" ? j?.principal : j?.balance;
      if (!a || raw === undefined) continue;
      const v = Number(raw) / 10 ** t.decimals;
      if (v > 0) sums.set(a, (sums.get(a) ?? 0) + v);
    }
    if (sums.size) {
      const { error } = await db.rpc("add_sui_holdings", { p_token: t.sym, p_scan: s.running, rows: [...sums].map(([a, v]) => ({ a, v })) });
      if (error) throw new Error(error.message);
    }
    s.objects += (o?.nodes ?? []).length; pages++;
    s.cursor = o?.pageInfo?.hasNextPage ? o.pageInfo.endCursor : null;
    if (!s.cursor) {
      // Finished: this scan becomes the current one; older scans of the token are removed
      const old = s.current;
      s.current = s.running; s.done_at = new Date().toISOString(); s.running = null;
      if (old && old !== s.current) await db.from("sui_holdings").delete().eq("token", t.sym).eq("scan_id", old);
      break;
    }
  }
  st.scans[t.sym] = s;
  result.scan = { token: t.sym, pages, objects: s.objects, done: !s.cursor && !!s.done_at && !s.running };
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
function bandRows(token: string, day: string, ranked: Ranked, prev: Prev, now: Map<string, number>) {
  const cutoff = ranked[ranked.length - 1][1], prevMap = new Map(prev.map((p) => [p.wallet, p])), top = new Set(ranked.map(([w]) => w));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const cur = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) { net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; if (!top.has(p.wallet)) left++; net += (now.get(p.wallet) ?? Math.min(cutoff, p.balance)) - p.balance; } }
    return { token, day, band, balance: cur.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? cur.filter(([w]) => !prevMap.has(w)).length : null };
  });
}
async function balances(t: Tok, addrs: string[], got: Record<string, number>) {
  const per = t.mode === "stake" ? 12 : 40;
  for (let i = 0; i < addrs.length && timeLeft() > 12000; i += per) {
    const part = addrs.slice(i, i + per);
    const body = part.map((a, k) => `a${k}: address(address: ${qs(a)}) { balance(coinType: ${qs(t.type)}) { totalBalance }` +
      (t.mode === "stake" ? ` objects(first: 50, filter: { type: ${qs(STAKED)} }) { nodes { asMoveObject { contents { json } } } }` : "") + " }").join(" ");
    const d = await gql(`{ ${body} }`);
    part.forEach((a, k) => {
      const x = d?.[`a${k}`];
      let v = Number(x?.balance?.totalBalance ?? 0) / 10 ** t.decimals;
      if (t.mode === "stake") for (const n of x?.objects?.nodes ?? []) v += Number(n?.asMoveObject?.contents?.json?.principal ?? 0) / 10 ** t.decimals;
      got[a] = v;
    });
  }
}
async function price(sym: string) {
  const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${sym}USDT`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  const j = r && r.status === 200 ? await r.json().catch(() => null) : null;
  if (j?.price) return +j.price;
  const { data } = await db.from("market_lists").select("data").eq("key", "top200").maybeSingle();
  const c = ((data?.data as any[]) ?? []).find((x) => String(x.symbol).toUpperCase() === sym);
  return c?.price ? +c.price : null;
}
async function snapshots(toks: Tok[], st: Record<string, any>, day: string, result: Record<string, unknown>) {
  const snap: { day: string; done: string[]; got: Record<string, Record<string, number>> } = st.snap?.day === day ? st.snap : { day, done: [], got: {} };
  for (const t of toks) {
    if (timeLeft() < 20000) break;
    const cur = st.scans?.[t.sym]?.current;
    if (!cur || snap.done.includes(t.sym)) continue;
    const { data: pool } = await db.from("sui_holdings").select("address").eq("token", t.sym).eq("scan_id", cur).order("amount", { ascending: false }).limit(POOL);
    const { data: prevRows } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", t.sym);
    const prev = (prevRows ?? []).filter((p) => p.day < day);
    const want = [...new Set([...(pool ?? []).map((r) => r.address), ...prev.map((p) => p.wallet)])];
    const got = snap.got[t.sym] ?? {};
    await balances(t, want.filter((a) => !(a in got)), got);
    snap.got[t.sym] = got;
    if (want.some((a) => !(a in got))) { result[`${t.sym}_snapshot`] = `${Object.keys(got).length}/${want.length} read`; break; }
    const now = new Map<string, number>(Object.entries(got as Record<string, number>));
    const ranked: Ranked = [...now].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, TOP);
    if (ranked.length < 10) { snap.done.push(t.sym); continue; }
    const bands = bandRows(t.sym, day, ranked, prev, now);
    let { error } = await db.from("holder_bands").upsert(bands);
    if (error) throw new Error(error.message);
    ({ error } = await db.from("holder_daily").upsert({ token: t.sym, day, price: await price(t.sym), holders: null, top10_pct: null, top100_pct: null,
      gini: gini(ranked.map(([, b]) => b)), excluded: 0, depth: ranked.length,
      source: t.mode === "stake" ? "sui graphql (ví stake SUI: số dư + stake)" : "sui graphql (toàn bộ coin của token)" }));
    if (error) throw new Error(error.message);
    await db.from("holder_snapshot").delete().eq("token", t.sym);
    for (let i = 0; i < ranked.length; i += 500) {
      ({ error } = await db.from("holder_snapshot").insert(ranked.slice(i, i + 500).map(([wallet, balance], j) => ({ token: t.sym, wallet, balance, rank: i + j + 1, day, exchange: null }))));
      if (error) throw new Error(error.message);
    }
    snap.done.push(t.sym); delete snap.got[t.sym];
    result[`${t.sym}_snapshot`] = { top: ranked.length, compared: prev.length > 0 };
  }
  st.snap = snap;
}

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now(), day = new Date().toISOString().slice(0, 10);
  deadline = started + RUN_BUDGET_MS;
  const lock = await loadState("sui_lock");
  if (lock.at && Date.now() - Date.parse(lock.at) < 150000) return Response.json({ ok: false, skipped: "busy" });
  await saveState("sui_lock", { at: new Date().toISOString() });
  const st = await loadState("sui_state"), result: Record<string, unknown> = {};
  try {
    if (!st.uni || Date.now() - Date.parse(st.uni.at) > UNI_DAYS * 864e5) {
      try { st.uni = { at: new Date().toISOString(), tokens: await buildUniverse() }; } catch (e) { result.universe_error = String(e).slice(0, 160); st.uni ??= { at: new Date(0).toISOString(), tokens: [{ sym: "SUI", type: SUI_TYPE, decimals: 9, mode: "stake" }] }; }
    }
    const toks: Tok[] = st.uni.tokens;
    result.tokens = toks.map((t) => t.sym);
    if (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() >= 7) { try { await snapshots(toks, st, day, result); } catch (e) { result.snapshot_error = String(e).slice(0, 160); } }
    if (timeLeft() > 20000) { try { await scan(toks, st, result); } catch (e) { result.scan_error = String(e).slice(0, 160); } }
  } finally {
    await saveState("sui_state", st);
    await saveState("sui_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
    await saveState("sui_lock", { at: null });
  }
  return Response.json({ ok: true, result });
});

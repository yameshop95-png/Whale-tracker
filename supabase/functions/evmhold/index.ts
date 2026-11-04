// Holder Flow for ARB (Arbitrum One) and AVAX (Avalanche C-Chain): a daily top-1,000 snapshot and a one-off
// 180-day history, written to holder_bands / holder_daily / holder_snapshot like the other coins.
//
// Daily (first call after 00:30 UTC):
// - ARB: GoldRush token holders on arbitrum-mainnet (page of 1,000 = 20 credits, counted in the shared
//   goldrush_usage with the holders function's caps).
// - AVAX: Routescan's address list sorted by balance (free, no key), 100 a page.
// Contracts are left out (pools, bridges, WAVAX, multisigs): eth_getCode on the chain's public RPC, cached;
// an EIP-7702 delegated wallet (code 0xef0100…) counts as a wallet. Wallets that left the list are read
// exactly from the public RPC.
// History: today's wallets' balances at the block of 01:00 UTC each day for the last 180 days, from an
// archive node (OnFinality, ONFINALITY_API_KEY), 100 calls a
// batch, capped per day. Limit (said on the page): only today's wallets are followed back in time.
// pg_cron calls this every 6 minutes (3, 9, …: apart from dothist, which also uses OnFinality); a call with nothing to do returns at once.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const OF_KEY = (Deno.env.get("ONFINALITY_API_KEY") ?? "").trim(), GR_KEY = (Deno.env.get("GOLDRUSH_API_KEY") ?? "").trim();
const mask = (s: string) => [OF_KEY, GR_KEY].reduce((m, k) => k.length > 8 ? m.split(k).join("***") : m, s);
const BUDGET_MS = 110_000, TOP = 1000, HIST_DAYS = 180, ARCHIVE_DAILY_CAP = 100_000;
// OnFinality counts every call inside a batch against its per-second limit: small batches, spaced out
const ARCHIVE_BATCH = 5, ARCHIVE_GAP_MS = 1000;
const GR_DAILY = 1500, GR_MONTHLY = 9500;   // the holders function's caps (shared counter)
// pubBatch: calls per batch on the public RPC (they refuse large batches); codeViaArchive: contract checks on
// the keyed node instead of the public one
// wrapped: the list comes from the wrapped token's holders (no native top list exists, e.g. Sonic), and each
// wallet counts native + wrapped
type Coin = { token: string | null; decimals: number; list: "goldrush" | "routescan"; gr?: string; chainId: number; pub: string; pubBatch: number; codeViaArchive?: boolean;
  wrapped?: string; archive: string | null; blocks?: string; binance: string; source: string };
const COINS: Record<string, Coin> = {
  ARB: { token: "0x912ce59144191c1204e64559fe8253a0e49e6548", decimals: 18, list: "goldrush", gr: "arbitrum-mainnet", chainId: 42161,
    pub: "https://arbitrum-one-rpc.publicnode.com", pubBatch: 20, archive: "https://arbitrum.api.onfinality.io/rpc", binance: "ARBUSDT", source: "goldrush (arbitrum)" },
  AVAX: { token: null, decimals: 18, list: "routescan", chainId: 43114,
    pub: "https://avalanche-c-chain-rpc.publicnode.com", pubBatch: 20, archive: "https://avalanche.api.onfinality.io/rpc/ext/bc/C/rpc", blocks: "https://api.avax.network/ext/bc/C/rpc", binance: "AVAXUSDT", source: "routescan (avalanche c-chain)" },
  // Sonic: no top list of native S anywhere (API), and OnFinality's Sonic node keeps no archive state, so daily
  // only, from the 1,000 largest wS holders, each counted as S + wS (approximate, said on the page)
  S: { token: null, wrapped: "0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38", decimals: 18, list: "goldrush", gr: "sonic-mainnet", chainId: 146,
    pub: "https://rpc.soniclabs.com", pubBatch: 20, archive: null, binance: "SUSDT", source: "goldrush wS + rpc (sonic, gần đúng)" },
};
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];
let T0 = 0;   // start of the current call
const timeUp = () => Date.now() - T0 > 95_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const loadState = async (key: string) => (await db.from("collector_state").select("value").eq("key", key).maybeSingle()).data?.value ?? {};
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });
const toUnits = (hexOrDec: string, dec: number) => { try { const v = BigInt(hexOrDec); return Number(v / 10n ** BigInt(Math.max(0, dec - 6))) / 1e6; } catch { return 0; } };

// JSON-RPC batch (100 calls), with retries; returns results in order (null for a failed call)
async function batch(url: string, calls: [string, unknown[]][], key = false): Promise<(string | null)[]> {
  const u = key ? `${url}?apikey=${OF_KEY}` : url;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30000),
        body: JSON.stringify(calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params }))) });
      const j: any = await r.json().catch(() => null);
      if (r.status === 200 && Array.isArray(j)) {
        const out: (string | null)[] = calls.map(() => null);
        for (const x of j) if (typeof x?.id === "number" && x.result != null) out[x.id] = x.result;
        if (out.some((x) => x !== null) || !calls.length) return out;
      }
      if (i === 2) throw new Error(`rpc ${r.status} ${mask(String(JSON.stringify(Array.isArray(j) ? (j[0]?.error ?? j[0] ?? "empty batch") : (j?.error ?? j)) ?? "no answer")).slice(0, 160)}`);
    } catch (e) { if (i === 2) throw new Error(mask(String(e)).slice(0, 160)); }
    await sleep(4000 * (i + 1));
  }
  return [];
}
const balanceCall = (c: Coin, w: string, tag: string): [string, unknown[]] => c.token
  ? ["eth_call", [{ to: c.token, data: "0x70a08231" + w.slice(2).toLowerCase().padStart(64, "0") }, tag]]
  : ["eth_getBalance", [w, tag]];

// Current balances (native + wrapped for a wrapped coin) of some wallets on the public RPC
async function balancesNow(c: Coin, wallets: string[]) {
  const m = new Map<string, number>();
  for (let i = 0; i < wallets.length && !timeUp(); i += c.pubBatch) {
    const part = wallets.slice(i, i + c.pubBatch);
    const calls: [string, unknown[]][] = part.map((w) => ["eth_getBalance", [w, "latest"]]);
    if (c.wrapped) calls.push(...part.map((w): [string, unknown[]] => ["eth_call", [{ to: c.wrapped, data: "0x70a08231" + w.slice(2).toLowerCase().padStart(64, "0") }, "latest"]]));
    const res = await batch(c.pub, calls).catch(() => []);
    part.forEach((w, j) => {
      if (c.token) { if (res[j] != null) m.set(w, toUnits(res[j]!, c.decimals)); return; }   // token: balanceOf below
      if (res[j] == null || (c.wrapped && res[part.length + j] == null)) return;
      m.set(w, toUnits(res[j]!, c.decimals) + (c.wrapped ? toUnits(res[part.length + j]!, c.decimals) : 0));
    });
    await sleep(400);
  }
  return m;
}

async function balancesNowNative(c: Coin, wallets: string[]) {
  const m = new Map<string, number>();
  for (let i = 0; i < wallets.length && !timeUp(); i += c.pubBatch) {
    const part = wallets.slice(i, i + c.pubBatch);
    const res = await batch(c.pub, part.map((w) => ["eth_getBalance", [w, "latest"]])).catch(() => []);
    part.forEach((w, j) => { if (res[j] != null) m.set(w, toUnits(res[j]!, c.decimals)); });
    await sleep(400);
  }
  return m;
}

// ---------------- daily list ----------------
async function grUse(credits: number) {
  const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
  const u: any = await loadState("goldrush_usage");
  const cur = { day, month, dayCredits: u.day === day ? +u.dayCredits || 0 : 0, monthCredits: u.month === month ? +u.monthCredits || 0 : 0 };
  if (cur.dayCredits + credits > GR_DAILY || cur.monthCredits + credits > GR_MONTHLY) throw new Error(`goldrush cap (${cur.dayCredits} today, ${cur.monthCredits} this month)`);
  cur.dayCredits += credits; cur.monthCredits += credits;
  await saveState("goldrush_usage", cur);
}
async function fetchList(sym: string, c: Coin): Promise<{ list: [string, number][]; supply: number | null }> {
  if (c.list === "goldrush") {
    await grUse(20);
    const r = await fetch(`https://api.covalenthq.com/v1/${c.gr}/tokens/${c.wrapped ?? c.token}/token_holders_v2/?page-size=1000`, { headers: { Authorization: `Bearer ${GR_KEY}` }, signal: AbortSignal.timeout(60000) });
    const j: any = await r.json().catch(() => null);
    if (r.status !== 200 || !Array.isArray(j?.data?.items)) throw new Error(`goldrush ${r.status} ${String(j?.error_message ?? "").slice(0, 100)}`);
    const items: any[] = j.data.items;
    const supply = items[0]?.total_supply && !c.wrapped ? toUnits(items[0].total_supply, c.decimals) : null;
    return { list: items.map((x) => [String(x.address).toLowerCase(), toUnits(x.balance, c.decimals)] as [string, number]), supply };
  }
  const list: [string, number][] = [];
  let url = `https://api.routescan.io/v2/network/mainnet/evm/${c.chainId}/addresses?sort=balance%2Cdesc&limit=100`;
  for (let page = 0; page < 13 && url; page++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const j: any = await r.json().catch(() => null);
    if (r.status !== 200 || !Array.isArray(j?.items)) { if (list.length >= 500) break; throw new Error(`routescan ${r.status}`); }
    for (const x of j.items) list.push([String(x.address).toLowerCase(), toUnits(x.balance, c.decimals)]);
    url = j.link?.next ? `https://api.routescan.io${j.link.next}` : "";
    await sleep(400);
  }
  return { list, supply: null };
}
// Contract check, cached per chain (1 = contract)
async function contracts(sym: string, c: Coin, addrs: string[]) {
  const key = `evm_code_${sym}`, cache: Record<string, number> = await loadState(key);
  const todo = addrs.filter((a) => !(a in cache));
  const viaKey = !!(c.codeViaArchive && c.archive && OF_KEY), size = viaKey ? 50 : c.pubBatch;
  for (let i = 0; i < todo.length && !timeUp(); i += size) {
    const part = todo.slice(i, i + size);
    const res = await batch(viaKey ? c.archive! : c.pub, part.map((a) => ["eth_getCode", [a, "latest"]]), viaKey).catch(() => []);
    part.forEach((a, j) => { const code = res[j]; if (code != null) cache[a] = code === "0x" || code.startsWith("0xef0100") ? 0 : 1; });
    await sleep(viaKey ? 250 : 600);
  }
  await saveState(key, cache);
  // unknown counts as a contract (left out)
  return { isContract: (a: string) => cache[a] === 1 || !(a in cache), unknown: addrs.filter((a) => !(a in cache)).length };
}
const gini = (xs: number[]) => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
};
type Prev = { wallet: string; balance: number; rank: number }[];
// Same method as the other coins: yesterday's members of a band, their balance today minus yesterday
function bandRows(token: string, day: string, ranked: [string, number][], prev: Prev, bal: (w: string) => number | undefined) {
  const cutoff = ranked[ranked.length - 1][1], prevMap = new Map(prev.map((p) => [p.wallet, p])), today = new Set(ranked.map(([w]) => w));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const now = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; if (!today.has(p.wallet)) left++; net += (bal(p.wallet) ?? Math.min(cutoff, p.balance)) - p.balance; }
    }
    return { token, day, band, balance: now.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null };
  });
}
async function price(c: Coin) {
  try { const j: any = await (await fetch(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${c.binance}`, { signal: AbortSignal.timeout(15000) })).json(); return +j.price || null; }
  catch { return null; }
}
async function daily(sym: string, c: Coin, day: string, result: Record<string, unknown>) {
  const { data: done } = await db.from("holder_daily").select("day").eq("token", sym).eq("day", day);
  if (done?.length) return;
  // The day's list is kept, so a call that fails later (contract checks) does not pay for it again
  const lk = `evm_list_${sym}`, cached: any = await loadState(lk);
  const got = cached.day === day ? cached : { day, ...(await fetchList(sym, c)) };
  if (cached.day !== day) await saveState(lk, got);
  // Wrapped coin: add each wallet's native balance (kept across calls until every wallet is read)
  if (c.wrapped && !got.withNative) {
    got.native ??= {};
    const todo = got.list.map(([a]: [string, number]) => a).filter((a: string) => !(a in got.native));
    const nat = await balancesNowNative(c, todo);
    for (const [a, b] of nat) got.native[a] = b;
    if (got.list.every(([a]: [string, number]) => a in got.native)) { got.list = got.list.map(([a, b]: [string, number]) => [a, b + got.native[a]]); got.withNative = true; delete got.native; }
    await saveState(lk, got);
    if (!got.withNative) throw new Error(`native balances: ${Object.keys(got.native).length}/${got.list.length}, continuing next call`);
  }
  const { list, supply } = got;
  const { isContract, unknown } = await contracts(sym, c, list.map(([a]: [string, number]) => a));
  if (unknown > list.length * 0.05) throw new Error(`contract check unfinished (${unknown} left), continuing next call`);
  const ranked: [string, number][] = list.filter(([a, b]: [string, number]) => b > 0 && !isContract(a)).sort((x: [string, number], y: [string, number]) => y[1] - x[1]).slice(0, TOP);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} ${sym} wallets`);
  const { data: prevRows } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", sym);
  const prev: Prev = (prevRows ?? []).filter((p) => p.day < day);
  const now = new Map(ranked);
  const left = prev.filter((p) => !now.has(p.wallet)).map((p) => p.wallet);
  if (c.wrapped) for (const [w, b] of await balancesNow(c, left)) now.set(w, b);   // exact balances of wallets that left the list
  else for (let i = 0; i < left.length; i += c.pubBatch) {
    const part = left.slice(i, i + c.pubBatch);
    const res = await batch(c.pub, part.map((w) => balanceCall(c, w, "latest"))).catch(() => []);
    part.forEach((w, j) => { if (res[j] != null) now.set(w, toUnits(res[j]!, c.decimals)); });
    await sleep(400);
  }
  const bands = bandRows(sym, day, ranked, prev, (w) => now.get(w));
  const share = (n: number) => supply ? 100 * ranked.slice(0, n).reduce((s, [, b]) => s + b, 0) / supply : null;
  let { error } = await db.from("holder_bands").upsert(bands);
  if (error) throw new Error(error.message);
  ({ error } = await db.from("holder_daily").upsert({ token: sym, day, price: await price(c), holders: null, top10_pct: share(10), top100_pct: share(100),
    gini: gini(ranked.map(([, b]) => b)), excluded: list.length - ranked.length, source: c.source, depth: ranked.length }));
  if (error) throw new Error(error.message);
  ({ error } = await db.from("holder_snapshot").delete().eq("token", sym));
  if (error) throw new Error(error.message);
  for (let i = 0; i < ranked.length; i += 500) {
    ({ error } = await db.from("holder_snapshot").insert(ranked.slice(i, i + 500).map(([wallet, balance], j) => ({ token: sym, wallet, balance, rank: i + j + 1, day, exchange: null }))));
    if (error) throw new Error(error.message);
  }
  result[`${sym}_daily`] = { wallets: ranked.length, excluded: list.length - ranked.length, compared: prev.length > 0, top1: Math.round(ranked[0][1]) };
}

// ---------------- history ----------------
async function blockTime(c: Coin, n: number) {
  const [b] = await batch(c.blocks ?? c.pub, [["eth_getBlockByNumber", ["0x" + n.toString(16), false]]]);
  if (!(b as any)?.timestamp) throw new Error(`no block ${n} on ${(c.blocks ?? c.pub).split("/")[2]}`);
  return { n, t: parseInt((b as any)?.timestamp ?? "0x0", 16) * 1000 };
}
// Last block at or before time t (secant steps on block timestamps, from the day before when known)
async function blockAt(c: Coin, t: number, hint?: { n: number; t: number }) {
  let a: { n: number; t: number }, b: { n: number; t: number };
  if (hint) { a = hint; b = await blockTime(c, hint.n + Math.round((t - hint.t) / ((hint as any).rate ?? 1000))); }
  else { const [h] = await batch(c.blocks ?? c.pub, [["eth_blockNumber", []]]); b = await blockTime(c, parseInt(String(h), 16)); a = await blockTime(c, b.n - 200000); }
  for (let i = 0; i < 14; i++) {
    if (a.n === b.n) a = await blockTime(c, b.n - 1000);
    const rate = (b.t - a.t) / (b.n - a.n) || 1000;
    const n = Math.max(1, Math.round(b.n - (b.t - t) / rate));
    const x = await blockTime(c, n);
    if (Math.abs(x.t - t) < 30_000) return { ...(x.t <= t ? x : await blockTime(c, n - 1)), rate };
    a = b; b = x;
  }
  return { ...b, rate: 1000 };
}
async function history(sym: string, c: Coin, today: string, started: number, result: Record<string, unknown>) {
  if (!c.archive || !OF_KEY) { result[`${sym}_history`] = "waiting for an archive node"; return; }
  const key = `evm_hist_${sym}`, st: any = await loadState(key);
  if (st.status === "written") return;
  if (!st.wallets) {
    const { data: first } = await db.from("holder_daily").select("day").eq("token", sym).order("day").limit(1);
    const { data: snap } = await db.from("holder_snapshot").select("wallet").eq("token", sym);
    if (!first?.length || !snap?.length) return;
    Object.assign(st, { status: "reading", firstLive: first[0].day, wallets: snap.map((r) => r.wallet), next: addDays(today, -HIST_DAYS), prev: [], used: {} });
  }
  if (!st.px) {   // daily opens for the history days (one call)
    const kl = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${c.binance}&interval=1d&limit=${HIST_DAYS + 10}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => []);
    st.px = Object.fromEntries((Array.isArray(kl) ? kl : []).map((k: any) => [new Date(+k[0]).toISOString().slice(0, 10), +k[1]]));
  }
  const used = st.used[today] ?? 0;
  let calls = 0;
  try {
    while (st.next <= st.firstLive && Date.now() - started < BUDGET_MS && used + calls + st.wallets.length <= ARCHIVE_DAILY_CAP) {
      const day = st.next, blk = await blockAt(c, Date.parse(day + "T01:00:00Z"), st.last);
      st.last = { n: blk.n, t: blk.t, rate: blk.rate };
      const tag = "0x" + blk.n.toString(16), bal = new Map<string, number>();
      for (let i = 0; i < st.wallets.length; i += ARCHIVE_BATCH) {
        if (Date.now() - started > BUDGET_MS + 20_000) throw new Error(`time up inside ${day}, continuing next call`);
        const part: string[] = st.wallets.slice(i, i + ARCHIVE_BATCH);
        const res = await batch(c.archive, part.map((w) => balanceCall(c, w, tag)), true);
        calls += part.length;
        part.forEach((w, j) => { if (res[j] != null) bal.set(w, toUnits(res[j]!, c.decimals)); });
        await sleep(ARCHIVE_GAP_MS);
      }
      if (bal.size < st.wallets.length * 0.9) throw new Error(`archive answered ${bal.size}/${st.wallets.length} for ${day}`);
      const ranked = [...bal].filter(([, b]) => b > 0).sort((x, y) => y[1] - x[1]).slice(0, TOP);
      if (ranked.length >= 10) {
        const rows = bandRows(sym, day, ranked, st.prev, (w) => bal.get(w) ?? 0);
        if (day === st.firstLive) {
          for (const r of rows) await db.from("holder_bands").update({ net: r.net, left_top: r.left_top, entered: r.entered }).eq("token", sym).eq("day", day).eq("band", r.band).is("net", null);
        } else {
          let { error } = await db.from("holder_bands").upsert(rows);
          if (error) throw new Error(error.message);
          ({ error } = await db.from("holder_daily").upsert({ token: sym, day, price: st.px?.[day] ?? null, holders: null, top10_pct: null, top100_pct: null,
            gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: `${c.source.split(" ")[0]} + onfinality (lịch sử dựng lại từ số dư của ví lớn hiện tại)`, depth: ranked.length }));
          if (error) throw new Error(error.message);
        }
        st.prev = ranked.map(([wallet, balance], i) => ({ wallet, balance, rank: i + 1 }));
      }
      st.next = addDays(day, 1);
    }
    if (st.next > st.firstLive) { st.status = "written"; st.prev = []; st.at = new Date().toISOString(); }
  } finally {
    st.used = { [today]: used + calls };
    await saveState(key, st);
  }
  result[`${sym}_history`] = st.status === "written" ? "done" : { next: st.next, calls_today: used + calls };
}

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = (T0 = Date.now()), result: Record<string, unknown> = {}, now = new Date(), day = now.toISOString().slice(0, 10);
  const afterSnapshotTime = now.getUTCHours() * 60 + now.getUTCMinutes() >= 30;   // 00:30 UTC
  for (const [sym, c] of Object.entries(COINS)) {
    try { if (afterSnapshotTime) await daily(sym, c, day, result); } catch (e) { result[`${sym}_daily_error`] = mask(String(e instanceof Error ? e.message : e)).slice(0, 200); }
    try { if (Date.now() - started < BUDGET_MS) await history(sym, c, day, started, result); } catch (e) { result[`${sym}_history_error`] = mask(String(e instanceof Error ? e.message : e)).slice(0, 200); }
  }
  if (Object.keys(result).length) await saveState("evmhold_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
  return Response.json({ ok: true, result });
});

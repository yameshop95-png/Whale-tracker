// Solana token holder history (one-off backfill) for the Solana tokens of Holder Flow (PYTH, PENGU, TRUMP, RAY,
// BOME): their live snapshots (Solana Tracker) start on 2026-10-31, so the 180 days before are rebuilt from
// each followed wallet's own token transactions on Solana's public RPC: the wallet's token accounts for the
// mint (getTokenAccountsByOwner, also today's balance), their signatures back to 180 days
// (getSignaturesForAddress), and for each transaction the wallet's token balance before and after
// (getTransaction pre/postTokenBalances). Balance at a day's 01:00 UTC = today's balance − every change after.
// Wallets with more than MAX_TX transactions in the window (busy exchange or program wallets) are left out.
// Same bands as the live snapshots. Limits (said on the page): only today's wallets and today's token accounts
// are followed back (a closed account's past is missing).
// One token at a time; pg_cron calls this every 3 minutes until every token is written.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// Helius (HELIUS_API_KEY, free plan) when set: much faster and higher limits than the public RPC
const HELIUS = (Deno.env.get("HELIUS_API_KEY") ?? "").trim();
const RPC = HELIUS ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS}` : "https://api.mainnet-beta.solana.com";
const TOKENS: [string, string][] = [
  ["PYTH", "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"],
  ["RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"],
  ["PENGU", "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv"],
  ["TRUMP", "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN"],
  ["BOME", "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82"],
];
const DAYS = 180, MAX_TX = 300, BUDGET_MS = 75_000, GAP_MS = HELIUS ? 40 : 250, PAR = HELIUS ? 5 : 1;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];
const SOURCE = "solana rpc (lịch sử dựng lại từ giao dịch của ví lớn hiện tại)";   // same label whichever node
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const loadState = async (key: string) => (await db.from("collector_state").select("value").eq("key", key).maybeSingle()).data?.value ?? {};
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

async function rpc(method: string, params: unknown[]) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20000) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    if (r?.status === 200 && j && !j.error) return j.result;
    if (i === 3) throw new Error(`solana rpc ${method} ${r?.status ?? 0} ${JSON.stringify(j?.error ?? "").slice(0, 100)}`);
    await sleep(r?.status === 429 ? 5000 * (i + 1) : 1500 * (i + 1));
  }
}
const gini = (xs: number[]) => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
};
type Prev = { wallet: string; balance: number; rank: number }[];
function bandRows(token: string, day: string, ranked: [string, number][], prev: Prev, all: Map<string, number>) {
  const prevMap = new Map(prev.map((p) => [p.wallet, p])), today = new Set(ranked.map(([w]) => w));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const now = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; if (!today.has(p.wallet)) left++; net += (all.get(p.wallet) ?? 0) - p.balance; }
    }
    return { token, day, band, balance: now.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null };
  });
}
// The day whose 01:00 UTC boundary a time (s) comes after
const dayOf = (sec: number) => { const d = new Date(sec * 1000), iso = d.toISOString(); return d.getUTCHours() >= 1 ? iso.slice(0, 10) : addDays(iso.slice(0, 10), -1); };

// One wallet, in two steps that can span calls: (1) its token accounts, today's balance and the signatures in
// the window; (2) each transaction's change of the wallet's balance, summed per day
async function startWallet(owner: string, mint: string, since: number) {
  const ta = await rpc("getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }]);
  await sleep(GAP_MS);
  const accts: any[] = ta?.value ?? [];
  const balance = accts.reduce((s, a) => s + (Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmountString) || 0), 0);
  const sigs: [string, number][] = [], seen = new Set<string>();
  for (const a of accts) {
    let before: string | undefined;
    for (;;) {
      const page: any[] = await rpc("getSignaturesForAddress", [a.pubkey, { limit: 1000, ...(before ? { before } : {}) }]) ?? [];
      await sleep(GAP_MS);
      for (const x of page) if (!x.err && (x.blockTime ?? 0) >= since && !seen.has(x.signature)) { seen.add(x.signature); sigs.push([x.signature, x.blockTime]); }
      if (sigs.length > MAX_TX) return { w: owner, skipped: `more than ${MAX_TX} transactions in ${DAYS} days` };
      if (page.length < 1000 || (page[page.length - 1].blockTime ?? 0) < since) break;
      before = page[page.length - 1].signature;
    }
  }
  return { w: owner, balance, sigs, i: 0, deltas: {} as Record<string, number> };
}
async function txDelta(sig: string, owner: string, mint: string) {
  const tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  await sleep(GAP_MS);
  const sum = (xs: any[]) => (xs ?? []).filter((x) => x.mint === mint && x.owner === owner).reduce((a, x) => a + (Number(x.uiTokenAmount?.uiAmountString) || 0), 0);
  return sum(tx?.meta?.postTokenBalances) - sum(tx?.meta?.preTokenBalances);
}

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now(), result: Record<string, unknown> = {};
  let key = "";
  let st: any = {};
  try {
    // The first token not written yet
    let sym = "", mint = "";
    for (const [t, m] of TOKENS) {
      const s0: any = await loadState(`sol_hist_${t}`);
      if (s0.status !== "written") { sym = t; mint = m; st = s0; break; }
    }
    if (!sym) return Response.json({ ok: true, result: { done: TOKENS.map(([t]) => t) } });
    key = `sol_hist_${sym}`;
    if (!st.wallets) {
      const { data: first } = await db.from("holder_daily").select("day").eq("token", sym).order("day").limit(1);
      const { data: snap } = await db.from("holder_snapshot").select("wallet").eq("token", sym).order("rank");
      if (!first?.length || !snap?.length) throw new Error(`no live ${sym} snapshot yet`);
      const days: string[] = [];
      for (let d = addDays(new Date().toISOString().slice(0, 10), -DAYS); d <= first[0].day; d = addDays(d, 1)) days.push(d);
      Object.assign(st, { status: "reading", firstLive: first[0].day, wallets: snap.map((r) => r.wallet), queue: snap.map((r) => r.wallet), days, data: {} });
    }
    const since = Math.floor(Date.parse(st.days[0] + "T01:00:00Z") / 1000);
    let n = 0;
    while ((st.cur || st.queue.length) && Date.now() - started < BUDGET_MS) {
      try {
        if (!st.cur) st.cur = await startWallet(st.queue.shift(), mint, since);
        const c = st.cur;
        if (c.skipped) { st.data[c.w] = { skipped: c.skipped }; st.cur = null; continue; }
        while (c.i < c.sigs.length && Date.now() - started < BUDGET_MS) {
          const part: [string, number][] = c.sigs.slice(c.i, c.i + PAR);   // a few transactions at once
          const ds = await Promise.all(part.map(([sig]) => txDelta(sig, c.w, mint)));
          part.forEach(([, t], j) => { if (ds[j]) c.deltas[dayOf(t)] = (c.deltas[dayOf(t)] ?? 0) + ds[j]; });
          c.i += part.length;
        }
        if (c.i >= c.sigs.length) { st.data[c.w] = { balance: c.balance, deltas: c.deltas }; st.cur = null; }
      } catch (e) {
        // a wallet the RPC keeps refusing is left out
        const w = st.cur?.w;
        if (w) { st.data[w] = { skipped: String(e instanceof Error ? e.message : e).slice(0, 80) }; st.cur = null; }
        else throw e;
      }
      if (++n % 10 === 0) await saveState(key, st);
    }
    if (st.cur || st.queue.length) { result[sym] = { read: Object.keys(st.data).length, left: st.queue.length + (st.cur ? 1 : 0) }; return Response.json({ ok: true, result }); }

    // Every wallet read: daily balances, bands and rows for the days before the first live day (net only for it)
    const kl = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1d&limit=${DAYS + 10}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => []);
    const priceOf = new Map((Array.isArray(kl) ? kl : []).map((k: any) => [new Date(+k[0]).toISOString().slice(0, 10), +k[1]]));
    const used = Object.entries(st.data as Record<string, any>).filter(([, v]) => !v.skipped);
    const bandOut: any[] = [], dailyOut: any[] = [];
    let prev: Prev = [];
    for (const day of st.days) {
      const all = new Map<string, number>();
      for (const [w, v] of used) {
        let b = v.balance ?? 0;
        for (const [d, x] of Object.entries(v.deltas as Record<string, number>)) if (d >= day) b -= x;
        all.set(w, Math.max(0, b));
      }
      const ranked = [...all].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, 1000);
      if (ranked.length < 10) { prev = []; continue; }
      const rows = bandRows(sym, day, ranked, prev, all);
      if (day === st.firstLive) {
        for (const r of rows) await db.from("holder_bands").update({ net: r.net, left_top: r.left_top, entered: r.entered }).eq("token", sym).eq("day", day).eq("band", r.band).is("net", null);
      } else {
        bandOut.push(...rows);
        dailyOut.push({ token: sym, day, price: priceOf.get(day) ?? null, holders: null, top10_pct: null, top100_pct: null, gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: SOURCE, depth: ranked.length });
      }
      prev = ranked.map(([wallet, balance], i) => ({ wallet, balance, rank: i + 1 }));
    }
    for (let i = 0; i < bandOut.length; i += 500) { const { error } = await db.from("holder_bands").upsert(bandOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    for (let i = 0; i < dailyOut.length; i += 500) { const { error } = await db.from("holder_daily").upsert(dailyOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    const skipped = Object.values(st.data as Record<string, any>).filter((v) => v.skipped).length;
    Object.assign(st, { status: "written", written: dailyOut.length, wallets_used: used.length, skipped, at: new Date().toISOString(), data: {}, queue: [] });
    result[sym] = { written: dailyOut.length, wallets: used.length, skipped };
  } catch (e) {
    result.error = String(e instanceof Error ? e.message : e).slice(0, 200);
  } finally {
    if (key) await saveState(key, st);
    await saveState("sol_hist_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
  }
  return Response.json({ ok: !result.error, result });
});

// SEI holder history (one-off backfill): the live SEI snapshots (Seistream) start on 2026-11-01, so the days
// before are rebuilt from the balances of today's top wallets at past block heights, read from the Sei
// Foundation's public REST node (rest.sei-apis.com, header x-cosmos-block-height). Public nodes keep only
// the last ~27 days of state, so oldest days go first (they expire first) and a day the node no longer has
// is skipped. Same bands and method as the live snapshots (yesterday's members, their balance today minus
// yesterday), at ~01:00 UTC of each day (when the live snapshot is taken). Bank balances only, like
// Seistream. Limit (said on the page): only today's top wallets are followed back, so wallets that were
// large then and have emptied since are missing.
// Called by pg_cron every 3 minutes until done; then it does nothing. Polite pace: 4 requests at a time.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const NODE = "https://rest.sei-apis.com", EVM_RPC = "https://evm-rpc.sei-apis.com";
const BUDGET_MS = 110_000, WORKERS = 4, GAP_MS = 60;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];
const SOURCE = "rest.sei-apis.com (lịch sử dựng lại từ số dư của ví lớn hiện tại)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const loadState = async (key: string) => (await db.from("collector_state").select("value").eq("key", key).maybeSingle()).data?.value ?? {};
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

async function lcd(path: string, height?: number) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(NODE + path, { headers: height ? { "x-cosmos-block-height": String(height) } : {}, signal: AbortSignal.timeout(15000) });
      const b: any = await r.json().catch(() => null);
      if (r.status === 200) return b;
      const msg = String(b?.message ?? "");
      if (/below earliest available/.test(msg)) throw Object.assign(new Error("pruned"), { pruned: true });
      if (r.status !== 429 && r.status < 500) throw new Error(`lcd ${r.status} ${msg.slice(0, 80)}`);
    } catch (e) { if ((e as any).pruned || i === 2) throw e; }
    await sleep(1000 * (i + 1));
  }
  throw new Error("lcd: no answer");
}
// Block time: the REST node keeps old state but prunes old block headers (a few days), so older headers come
// from Sei's public EVM RPC (same block numbers); null when neither has the block
async function blockTime(h?: number): Promise<{ h: number; t: number } | null> {
  try {
    const b = await lcd(`/cosmos/base/tendermint/v1beta1/blocks/${h ?? "latest"}`);
    return { h: +b.block.header.height, t: Date.parse(b.block.header.time) };
  } catch { /* try the EVM RPC */ }
  if (h == null) return null;
  try {
    const r = await fetch(EVM_RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + h.toString(16), false] }) });
    const j: any = await r.json();
    return j?.result?.timestamp ? { h, t: parseInt(j.result.timestamp, 16) * 1000 } : null;
  } catch { return null; }
}
// Height of the last block before time t: refined from the average block time while block times are
// readable; otherwise the estimate from recent blocks (off by well under an hour over a few weeks)
async function heightAt(t: number) {
  const L = (await blockTime())!, P = await blockTime(L.h - 100000);
  let bt = P ? (L.t - P.t) / 100000 : 470;
  let h = Math.round(L.h - (L.t - t) / bt);
  for (let i = 0; i < 5; i++) {
    const b = await blockTime(h);
    if (!b) break;
    const step = Math.round((t - b.t) / bt);
    if (Math.abs(step) < 3) return b.t <= t ? b.h : b.h - 1;
    if (i === 0 && L.h !== b.h) bt = (L.t - b.t) / (L.h - b.h);   // average over the whole gap
    h += step;
  }
  return h;
}
const gini = (xs: number[]) => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
};
type Prev = { wallet: string; balance: number; rank: number }[];
// Every followed wallet's balance is known each day, so wallets that left a band count at their exact balance
function bandRows(day: string, ranked: [string, number][], prev: Prev, all: Map<string, number>) {
  const prevMap = new Map(prev.map((p) => [p.wallet, p])), today = new Map(ranked.map(([w], i) => [w, i + 1]));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const now = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; if (!today.has(p.wallet)) left++; net += (all.get(p.wallet) ?? 0) - p.balance; }
    }
    return { token: "SEI", day, band, balance: now.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null };
  });
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
  const st: any = await loadState("sei_hist");
  try {
    if (st.status === "written") return Response.json({ ok: true, result: { done: st } });
    if (!st.wallets) {
      const { data: first } = await db.from("holder_daily").select("day").eq("token", "SEI").order("day").limit(1);
      const { data: snap } = await db.from("holder_snapshot").select("wallet").eq("token", "SEI");
      if (!first?.length || !snap?.length) throw new Error("no live SEI snapshot yet");
      const firstLive = first[0].day;
      // Days from 27 days ago up to the first live day (its net is recomputed against the day before)
      const days: string[] = [];
      for (let d = addDays(new Date().toISOString().slice(0, 10), -27); d <= firstLive; d = addDays(d, 1)) days.push(d);
      Object.assign(st, { status: "reading", firstLive, wallets: snap.map((r) => r.wallet), days, done: [], skipped: [], cur: null });
    }
    // One day at a time, oldest first; a day's balances are kept in its own state row
    while (Date.now() - started < BUDGET_MS) {
      if (!st.cur) {
        const day = st.days.find((d: string) => !st.done.includes(d) && !st.skipped.includes(d));
        if (!day) break;
        try {
          const h = await heightAt(Date.parse(day + "T01:00:00Z"));
          const sup = await lcd(`/cosmos/bank/v1beta1/supply/by_denom?denom=usei`, h);
          st.cur = { day, h, supply: +(sup?.amount?.amount ?? 0) / 1e6 };
          await saveState("sei_hist_day", { day, bal: {} });
        } catch (e) { if ((e as any).pruned) { st.skipped.push(day); continue; } throw e; }
      }
      const cur = st.cur, dayState: any = await loadState("sei_hist_day");
      const bal: Record<string, number> = dayState.day === cur.day ? dayState.bal ?? {} : {};
      const todo: string[] = st.wallets.filter((w: string) => !(w in bal));
      let pruned = false, i = 0;
      await Promise.all(Array.from({ length: WORKERS }, async () => {
        while (!pruned && i < todo.length && Date.now() - started < BUDGET_MS) {
          const w = todo[i++];
          try { const b = await lcd(`/cosmos/bank/v1beta1/balances/${w}/by_denom?denom=usei`, cur.h); bal[w] = +(b?.balance?.amount ?? 0) / 1e6; }
          catch (e) { if ((e as any).pruned) pruned = true; else result.errors = ((result.errors as number) ?? 0) + 1; }
          await sleep(GAP_MS);
        }
      }));
      if (pruned) { st.skipped.push(cur.day); st.cur = null; continue; }
      await saveState("sei_hist_day", { day: cur.day, bal });
      if (st.wallets.every((w: string) => w in bal)) {
        await saveState(`sei_hist_${cur.day}`, { h: cur.h, supply: cur.supply, bal });
        st.done.push(cur.day); st.cur = null;
      } else break;
    }
    const left = st.days.filter((d: string) => !st.done.includes(d) && !st.skipped.includes(d));
    if (left.length) { result.progress = { done: st.done.length, skipped: st.skipped.length, left: left.length, cur: st.cur?.day ?? null }; return Response.json({ ok: true, result }); }

    // Every day read: bands and daily rows for the days before the first live day, net only for that day
    const kl = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=SEIUSDT&interval=1d&limit=60`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => []);
    const priceOf = new Map((Array.isArray(kl) ? kl : []).map((k: any) => [new Date(+k[0]).toISOString().slice(0, 10), +k[1]]));
    const bandOut: any[] = [], dailyOut: any[] = [];
    let prev: Prev = [], prevDay = "";
    for (const day of st.days.filter((d: string) => st.done.includes(d))) {
      const s: any = await loadState(`sei_hist_${day}`);
      const all = new Map<string, number>(Object.entries(s.bal ?? {}));
      const ranked = [...all].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, 1000);
      if (ranked.length < 10) continue;
      // A gap (a skipped day) breaks the day-to-day comparison
      const p = prevDay && addDays(prevDay, 1) === day ? prev : [];
      const rows = bandRows(day, ranked, p, all);
      if (day === st.firstLive) {
        for (const r of rows) await db.from("holder_bands").update({ net: r.net, left_top: r.left_top, entered: r.entered }).eq("token", "SEI").eq("day", day).eq("band", r.band).is("net", null);
      } else {
        bandOut.push(...rows);
        const share = (n: number) => s.supply > 0 ? 100 * ranked.slice(0, n).reduce((a, [, b]) => a + b, 0) / s.supply : null;
        dailyOut.push({ token: "SEI", day, price: priceOf.get(day) ?? null, holders: null, top10_pct: share(10), top100_pct: share(100), gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: SOURCE, depth: ranked.length });
      }
      prev = ranked.map(([wallet, balance], i) => ({ wallet, balance, rank: i + 1 })); prevDay = day;
    }
    for (let i = 0; i < bandOut.length; i += 500) { const { error } = await db.from("holder_bands").upsert(bandOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    for (let i = 0; i < dailyOut.length; i += 500) { const { error } = await db.from("holder_daily").upsert(dailyOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    Object.assign(st, { status: "written", written: dailyOut.length, at: new Date().toISOString() });
    result.written = { days: dailyOut.length, from: dailyOut[0]?.day, to: dailyOut[dailyOut.length - 1]?.day, skipped: st.skipped };
  } catch (e) {
    result.error = String(e instanceof Error ? e.message : e).slice(0, 200);
  } finally {
    await saveState("sei_hist", st);
    await saveState("sei_hist_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
  }
  return Response.json({ ok: !result.error, result });
});

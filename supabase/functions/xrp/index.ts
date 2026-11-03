// XRP holders from XRPSCAN's public API (https://docs.xrpscan.com): /api/v1/balances lists the 10,000
// largest accounts, refreshed nightly, with names for exchanges and companies. Licence: CC BY-NC-SA 4.0
// (non-commercial, attribution): the source is named on every row and on the pages.
// Once a day (after 01:00 UTC, retried until done) the top 1,000 are stored like the other coins
// (holder_bands / holder_daily / holder_snapshot, token "XRP").
// Balance = liquid balance + escrow ("supply" in the list), so Ripple's monthly escrow releases are not
// counted as buying. Named exchange accounts go to the 'cex' band, the 50 largest others to 'whale_ex'.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SOURCE = "xrpscan (CC BY-NC-SA 4.0)";
const TOP = 1000;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];
// Named accounts that are not exchanges (company treasury, bridges, protocols, people, a hack)
const NOT_EXCHANGE = new Set(["ripple", "axelar bridge", "binance charity", "doppler finance", "evernorth", "flare core vault", "near", "nobitex hack",
  "pulsex sacrifice", "union chain", "xpr bridge", "first ledger", "ahbritto", "chrislarsen", "coinbase cbxrp", "cobo custody"]);
const isExchange = (name: string | null) => !!name && !NOT_EXCHANGE.has(name.toLowerCase());

const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });
type Prev = { wallet: string; balance: number; rank: number; exchange: string | null }[];
type Ranked = [string, number][];

function gini(xs: number[]) {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
}
// Yesterday's members of a band, their balance today minus yesterday. A wallet that left the top 1,000
// counts at its balance in the 10,000 list, or at most the cut-off when it is not there either.
function bandRows(day: string, ranked: Ranked, prev: Prev, all: Map<string, number>) {
  const cutoff = ranked[ranked.length - 1][1];
  const prevMap = new Map(prev.map((p) => [p.wallet, p]));
  const net = (ps: Prev) => { if (!prev.length) return { net: null as number | null, left: null as number | null };
    let n = 0, left = 0; const top = new Set(ranked.map(([w]) => w));
    for (const p of ps) { if (!top.has(p.wallet)) left++; n += (all.get(p.wallet) ?? Math.min(cutoff, p.balance)) - p.balance; }
    return { net: n, left }; };
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const cur = ranked.slice(lo - 1, hi), r = net(prev.filter((p) => p.rank >= lo && p.rank <= hi));
    return { token: "XRP", day, band, balance: cur.reduce((s, [, b]) => s + b, 0), net: r.net, left_top: r.left, entered: prev.length ? cur.filter(([w]) => !prevMap.has(w)).length : null };
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
  const started = Date.now(), day = new Date().toISOString().slice(0, 10);
  const result: Record<string, unknown> = {};
  try {
    const { data: done } = await db.from("holder_daily").select("day").eq("token", "XRP").eq("day", day);
    if (done?.length) { result.snapshot = "done today"; return Response.json({ ok: true, result }); }
    const r = await fetch("https://api.xrpscan.com/api/v1/balances", { signal: AbortSignal.timeout(60000) });
    if (r.status !== 200) throw new Error(`xrpscan ${r.status}`);
    const list = await r.json();
    if (!Array.isArray(list) || list.length < TOP) throw new Error(`xrpscan: only ${Array.isArray(list) ? list.length : 0} accounts`);
    const name = new Map<string, string | null>();
    const all = new Map<string, number>();
    for (const e of list) {
      const a = String(e?.account ?? ""); if (!a.startsWith("r")) continue;
      const total = (+e.supply || (+e.balance || 0) + (+e.escrow || 0)) / 1e6;   // drops -> XRP
      all.set(a, total); name.set(a, e?.name?.name ? String(e.name.name).slice(0, 40) : null);
    }
    const ranked: Ranked = [...all].filter(([, b]) => b > 0).sort((x, y) => y[1] - x[1]).slice(0, TOP);
    const { data: prevRows, error: pe } = await db.from("holder_snapshot").select("wallet,balance,rank,day,exchange").eq("token", "XRP");
    if (pe) throw pe;
    const prev: Prev = (prevRows ?? []).filter((p) => p.day < day);
    let bands: any[] = bandRows(day, ranked, prev, all);
    // Exchange and whale cohorts (same method as the EVM coins)
    const exNow = (w: string) => isExchange(name.get(w) ?? null);
    const cohort = (ps: Prev) => { if (!prev.length) return { net: null as number | null, left: null as number | null };
      let n = 0, left = 0; const top = new Set(ranked.map(([w]) => w)); const cutoff = ranked[ranked.length - 1][1];
      for (const p of ps) { if (!top.has(p.wallet)) left++; n += (all.get(p.wallet) ?? Math.min(cutoff, p.balance)) - p.balance; } return { net: n, left }; };
    const whalesNow = ranked.filter(([w]) => !exNow(w)).slice(0, 50), cexNow = ranked.filter(([w]) => exNow(w));
    const whalesPrev = [...prev].sort((a, b) => a.rank - b.rank).filter((p) => !isExchange(p.exchange ?? name.get(p.wallet) ?? null)).slice(0, 50);
    const cexPrev = prev.filter((p) => isExchange(p.exchange ?? name.get(p.wallet) ?? null));
    const w = cohort(whalesPrev), c = cohort(cexPrev);
    bands = [...bands,
      { token: "XRP", day, band: "whale_ex", balance: whalesNow.reduce((s, [, b]) => s + b, 0), net: w.net, left_top: w.left, entered: null },
      { token: "XRP", day, band: "cex", balance: cexNow.reduce((s, [, b]) => s + b, 0), net: c.net, left_top: c.left, entered: null }];
    const px = await fetch("https://data-api.binance.vision/api/v3/ticker/price?symbol=XRPUSDT", { signal: AbortSignal.timeout(15000) }).then((x) => x.json()).catch(() => null);
    let { error } = await db.from("holder_bands").upsert(bands);
    if (error) throw error;
    ({ error } = await db.from("holder_daily").upsert({ token: "XRP", day, price: px?.price ? +px.price : null, holders: null, top10_pct: null, top100_pct: null,
      gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: SOURCE, depth: ranked.length }));
    if (error) throw error;
    ({ error } = await db.from("holder_snapshot").delete().eq("token", "XRP"));
    if (error) throw error;
    for (let i = 0; i < ranked.length; i += 500) {
      ({ error } = await db.from("holder_snapshot").insert(ranked.slice(i, i + 500).map(([wallet, balance], j) => ({ token: "XRP", wallet, balance, rank: i + j + 1, day, exchange: name.get(wallet) && exNow(wallet) ? name.get(wallet) : null }))));
      if (error) throw error;
    }
    result.snapshot = { top: ranked.length, compared: prev.length > 0, exchanges_in_top: cexNow.length, top1: Math.round(ranked[0][1]), net_1_100: bands.find((b) => b.band === "1-100")?.net ?? null };
  } catch (e) {
    result.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  } finally {
    await saveState("xrp_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
  }
  return Response.json({ ok: !result.error, result });
});

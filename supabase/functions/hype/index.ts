// HYPE holders on Hyperliquid's own chain (HyperCore), from Hypurrscan's public API
// (https://api.hypurrscan.io/holders/HYPE: every holder's spot balance, no key, documented rate limit
// 1000 weight/minute/IP; one call a day here). HYPE staked with validators and HYPE on HyperEVM are not in
// this list. Once a day (after 01:00 UTC, retried until done) the top 1,000 are stored like the other coins
// (holder_bands / holder_daily / holder_snapshot, token "HYPE"). The list holds every wallet, so a wallet
// that left yesterday's top keeps its real balance in the daily change. Price: Hyperliquid's public info API.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TOP = 1000;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];

type Prev = { wallet: string; balance: number; rank: number }[];
type Ranked = [string, number][];
function gini(xs: number[]) {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
}
// Yesterday's members of a band, their balance today (from the full list) minus yesterday's
function bandRows(day: string, ranked: Ranked, prev: Prev, all: Record<string, number>) {
  const top = new Set(ranked.map(([w]) => w)), prevMap = new Map(prev.map((p) => [p.wallet, p]));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const cur = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) { net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; if (!top.has(p.wallet)) left++; net += (Number(all[p.wallet]) || 0) - p.balance; } }
    return { token: "HYPE", day, band, balance: cur.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? cur.filter(([w]) => !prevMap.has(w)).length : null };
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
    const { data: done } = await db.from("holder_daily").select("day").eq("token", "HYPE").eq("day", day);
    if (done?.length) { result.snapshot = "done today"; return Response.json({ ok: true, result }); }
    const r = await fetch("https://api.hypurrscan.io/holders/HYPE", { signal: AbortSignal.timeout(90000) });
    if (r.status !== 200) throw new Error(`hypurrscan ${r.status}`);
    const body = await r.json();
    // The docs call the map "addresses"; the live API returns it as "holders"
    const all: Record<string, number> = body?.holders ?? body?.addresses ?? {};
    const ranked: Ranked = Object.entries(all).map(([a, v]) => [a.toLowerCase(), Number(v)] as [string, number])
      .filter(([a, v]) => /^0x[0-9a-f]{40}$/.test(a) && v > 0).sort((a, b) => b[1] - a[1]).slice(0, TOP);
    if (ranked.length < 10) throw new Error(`only ${ranked.length} holders returned`);
    result.holders = body?.holdersCount ?? body?.length ?? Object.keys(all).length;
    result.list_time = body?.lastUpdate ? new Date(body.lastUpdate * 1000).toISOString() : null;
    const { data: prevRows, error: pe } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", "HYPE");
    if (pe) throw pe;
    const prev = (prevRows ?? []).filter((p) => p.day < day);
    const bands = bandRows(day, ranked, prev, all);
    const mids = await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }), signal: AbortSignal.timeout(15000) })
      .then((x) => x.json()).catch(() => null);
    const price = +(mids?.HYPE ?? 0) || null;
    const total = Object.values(all).reduce((s, v) => s + (Number(v) || 0), 0);
    let { error } = await db.from("holder_bands").upsert(bands);
    if (error) throw error;
    ({ error } = await db.from("holder_daily").upsert({ token: "HYPE", day, price, holders: Number(result.holders) || null,
      top10_pct: total ? 100 * ranked.slice(0, 10).reduce((s, [, b]) => s + b, 0) / total : null,
      top100_pct: total ? 100 * ranked.slice(0, 100).reduce((s, [, b]) => s + b, 0) / total : null,
      gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: "hypurrscan (hypercore spot)", depth: ranked.length }));
    if (error) throw error;
    ({ error } = await db.from("holder_snapshot").delete().eq("token", "HYPE"));
    if (error) throw error;
    for (let i = 0; i < ranked.length; i += 500) {
      ({ error } = await db.from("holder_snapshot").insert(ranked.slice(i, i + 500).map(([wallet, balance], j) => ({ token: "HYPE", wallet, balance, rank: i + j + 1, day, exchange: null }))));
      if (error) throw error;
    }
    result.snapshot = { top: ranked.length, compared: prev.length > 0, top1: Math.round(ranked[0][1]), price, spot_total: Math.round(total) };
  } catch (e) {
    result.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  } finally {
    await db.from("collector_state").upsert({ key: "hype_status", value: { at: new Date().toISOString(), ms: Date.now() - started, result }, updated_at: new Date().toISOString() });
  }
  return Response.json({ ok: !result.error, result });
});

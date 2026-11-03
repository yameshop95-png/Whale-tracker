// Bitcoin on-chain price bands from BGeometrics (https://bitcoin-data.com, API https://api.bitcoin-data.com):
// Realized Price, Balanced Price and CVDD, daily (Delta Price computed with Coin Metrics, below). Free plan: 15 requests a day, 4 years of history,
// personal / non-commercial publishing with attribution (the page credits BGeometrics). One call per metric
// once a day after their 03:00 UTC update; the key (secret BGEOMETRICS_API_KEY) is sent as a Bearer token and
// masked in errors. Stored in market_lists "btc_bands" as [day, realized, balanced, delta, cvdd] rows for
// the Smart Bands page.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const KEY = (Deno.env.get("BGEOMETRICS_API_KEY") ?? "").trim();
const API = "https://api.bitcoin-data.com/v1";
// BGeometrics' "delta-price-usd" is a noisy daily figure, not Woo's Delta Price, so Delta is computed here:
// (Realized Cap − Average Cap) ÷ supply, Average Cap = mean of every daily market cap since 2010, from Coin
// Metrics' free community data (CC BY-NC 4.0, credited on the page)
const METRICS: [string, string][] = [["realized-price", "realizedPrice"], ["balanced-price", "balancedPrice"], ["cvdd", "cvdd"]];
const CM = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMrktCurUSD,SplyCur&frequency=1d&page_size=10000&start_time=2009-01-01";

// Average Cap per coin on each day (cumulative mean of the market cap ÷ that day's supply)
async function avgCapPerCoin() {
  const r = await fetch(CM, { signal: AbortSignal.timeout(60000) });
  if (r.status !== 200) throw new Error(`coinmetrics ${r.status}`);
  const rows: any[] = (await r.json())?.data ?? [];
  const out = new Map<string, number>(); let sum = 0, n = 0;
  for (const x of rows) {
    const cap = Number(x.CapMrktCurUSD), sply = Number(x.SplyCur);
    if (!Number.isFinite(cap) || cap <= 0 || !(sply > 0)) continue;
    sum += cap; n++;
    out.set(String(x.time).slice(0, 10), sum / n / sply);
  }
  return out;
}
const mask = (m: string) => KEY.length > 4 ? m.split(KEY).join("***") : m;

async function series(path: string, field: string, signed = false) {
  const r = await fetch(`${API}/${path}?size=5000`, { headers: KEY ? { Authorization: `Bearer ${KEY}` } : {}, signal: AbortSignal.timeout(45000) });
  const body = await r.json().catch(() => null);
  if (r.status !== 200) throw new Error(mask(`${path} ${r.status} ${JSON.stringify(body?.message ?? body?.error ?? "").slice(0, 120)}`));
  // The list comes either as an array or inside "content" (paged)
  const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.content) ? body.content : [];
  const out = new Map<string, number>();
  for (const x of rows) { const v = Number(x?.[field]); if (typeof x?.d === "string" && Number.isFinite(v) && (signed || v > 0)) out.set(x.d.slice(0, 10), v); }
  if (!out.size) throw new Error(`${path}: no rows`);
  return out;
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
  try {
    // Once a day: skip when today's data is already stored
    const { data: have } = await db.from("market_lists").select("updated_at").eq("key", "btc_bands").maybeSingle();
    const fresh = new Date(); fresh.setUTCHours(3, 0, 0, 0);
    if (fresh.getTime() > Date.now()) fresh.setUTCDate(fresh.getUTCDate() - 1);   // their last update
    const force = (await req.json().catch(() => ({})))?.force === true;   // manual re-run after a code change
    if (!force && have?.updated_at && Date.parse(have.updated_at) >= fresh.getTime()) { result.skipped = "done since the last update"; return Response.json({ ok: true, result }); }
    const maps: Map<string, number>[] = [];
    for (const [path, field] of METRICS) { maps.push(await series(path, field)); await new Promise((r) => setTimeout(r, 1500)); }
    // Realized Price momentum (30-day change of the realized price, BGeometrics): capital flowing in or out.
    // Not delayed like the bands; a failure here does not stop the bands
    let mom: [string, number][] = [];
    try { mom = [...(await series("realized-price-momentum", "realizedPriceMomentum30d", true))].sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-400); }
    catch (e) { result.momentum_error = mask(String(e)).slice(0, 120); }
    let avg = new Map<string, number>();
    try { avg = await avgCapPerCoin(); } catch (e) { result.delta_error = String(e).slice(0, 120); }
    const days = [...maps[0].keys()].sort();
    const rows = days.map((d) => {
      const r = maps[0].get(d)!, a = avg.get(d);
      const delta = a != null && r - a > 0 ? Math.round((r - a) * 100) / 100 : null;
      return [d, r, maps[1].get(d) ?? null, delta, maps[2].get(d) ?? null];
    });
    const { error } = await db.from("market_lists").upsert({ key: "btc_bands", data: { source: "BGeometrics (bitcoin-data.com); Delta: Coin Metrics community data", cols: ["day", "realized", "balanced", "delta", "cvdd"], rows, momentum: mom }, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    const last = rows[rows.length - 1];
    result.stored = { days: rows.length, from: days[0], to: last[0], realized: last[1], balanced: last[2], delta: last[3], cvdd: last[4], momentum: mom[mom.length - 1] ?? null, keyed: !!KEY };
  } catch (e) {
    result.error = mask(e instanceof Error ? e.message : String(e)).slice(0, 200);
  } finally {
    await db.from("collector_state").upsert({ key: "bgeo_status", value: { at: new Date().toISOString(), ms: Date.now() - started, result }, updated_at: new Date().toISOString() });
  }
  return Response.json({ ok: !result.error, result });
});

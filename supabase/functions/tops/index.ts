// Ranked lists for the home page, Holder Flow and Smart Bands, computed once an hour while the daily
// holder snapshots come in (01:55–09:55 UTC) and stored in market_lists "tops" (public read):
//  - hf:    Holder Flow, the 10 largest green / red bubbles of the latest snapshot day: net change of the
//           top 100 wallets of each coin, in USD at that day's price
//  - whale: Gem Radar's whale tickers (top 1–50 wallets, or the 50 largest non-exchange wallets when the
//           day has exchange labels), same day rule
//  - sb:    Smart Bands, coins whose price is above their realized price: the real one for BTC (BGeometrics),
//           the estimate of the Smart Bands page for the others (cost basis of the top 100 wallets, at
//           least 30 days of data), with the day the price last crossed above it
// The latest day with at least 8 coins is used (early in the day the day before is still the complete one).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MIN_DAYS = 30, KEEP = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dn = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / 864e5);

// Every row of the last KEEP days, 1,000 at a time (the API's page size)
async function all(table: string, cols: string, bandsOnly = false): Promise<any[]> {
  const out: any[] = [], since = new Date(Date.now() - KEEP * 864e5).toISOString().slice(0, 10);
  for (let from = 0; from < 500000; from += 1000) {
    let q = db.from(table).select(cols).gte("day", since);
    if (bandsOnly) q = q.in("band", ["1-10", "11-50", "51-100", "1-100", "whale_ex"]);
    const { data, error } = await q.order("day").order("token").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
const sum = (b: Record<string, number> | undefined, ks: string[]) => b && ks.every((k) => b[k] != null) ? ks.reduce((s, k) => s + b[k], 0) : null;
const top100 = (b?: Record<string, number>) => sum(b, ["1-10", "11-50", "51-100"]) ?? b?.["1-100"] ?? null;

// Daily candles for the realized estimate (volume-weighted price of a day); Binance, else OKX
async function klines(sym: string): Promise<Map<number, { c: number; vwap: number | null }>> {
  const m = new Map<number, { c: number; vwap: number | null }>();
  try {
    const r = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1d&limit=1000`, { signal: AbortSignal.timeout(15000) });
    if (r.ok) for (const k of await r.json() as any[]) m.set(Math.round(k[0] / 864e5), { c: +k[4], vwap: +k[5] > 0 ? +k[7] / +k[5] : null });
  } catch { /* fall back below */ }
  if (m.size) return m;
  try {
    const r = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT&bar=1Dutc&limit=300`, { signal: AbortSignal.timeout(15000) });
    const j: any = r.ok ? await r.json() : null;
    for (const k of j?.data ?? []) m.set(Math.round(+k[0] / 864e5), { c: +k[4], vwap: +k[5] > 0 ? +k[7] / +k[5] : null });
  } catch { /* none */ }
  return m;
}

// Same estimate as the Smart Bands page: coins held on the first day valued at the average traded price of
// the year before, then each net buy adds cost at the day's price and each net sale removes coins at cost
function realized(net: Map<number, number>, bal: Map<number, number>, price: Map<number, number>, k: Map<number, { c: number; vwap: number | null }>, lastN: number) {
  const t0 = [...bal.keys()].sort((a, b) => a - b)[0];
  if (t0 == null) return null;
  const pre = [...k.entries()].filter(([d, x]) => d < t0 && d >= t0 - 365 && x.vwap);
  const prior = pre.length ? pre.reduce((s, [, x]) => s + x.vwap!, 0) / pre.length : (k.get(t0)?.c ?? price.get(t0) ?? null);
  if (!prior) return null;
  const flow = (n: number) => k.get(n - 1)?.vwap ?? ((price.get(n) && price.get(n - 1)) ? (price.get(n)! + price.get(n - 1)!) / 2 : price.get(n) ?? null);
  let H = bal.get(t0)!, cost = H * prior;
  const R = new Map<number, number>([[t0, prior]]);
  for (let n = t0 + 1; n <= lastN; n++) {
    const v = net.get(n), p = flow(n);
    if (v != null && p && H > 0) {
      if (v > 0) { cost += v * p; H += v; }
      else { const sold = Math.min(-v, H * 0.999); cost -= sold * cost / H; H -= sold; }
    }
    R.set(n, cost / H);
  }
  return { R, days: R.size };
}

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now(), errors: Record<string, string> = {};
  try {
    const [bands, daily] = await Promise.all([
      all("holder_bands", "token,day,band,net,balance", true),
      all("holder_daily", "token,day,price"),
    ]);
    const priceOf = new Map(daily.map((d) => [d.token + d.day, +d.price || null]));
    // by token: day number -> band -> net / balance
    const netBy = new Map<string, Map<number, Record<string, number>>>(), balBy = new Map<string, Map<number, Record<string, number>>>();
    for (const b of bands) {
      const n = dn(b.day);
      if (b.net != null) { const m = netBy.get(b.token) ?? new Map(); (m.get(n) ?? m.set(n, {}).get(n))[b.band] = +b.net; netBy.set(b.token, m); }
      if (b.balance != null) { const m = balBy.get(b.token) ?? new Map(); (m.get(n) ?? m.set(n, {}).get(n))[b.band] = +b.balance; balBy.set(b.token, m); }
    }
    // The day the lists are for: the latest with at least 8 coins carrying a net change
    const perDay = new Map<number, number>();
    for (const m of netBy.values()) for (const n of m.keys()) perDay.set(n, (perDay.get(n) ?? 0) + 1);
    const days = [...perDay.keys()].sort((a, b) => b - a);
    const day = days.find((n) => perDay.get(n)! >= 8) ?? days[0];
    const dayStr = day != null ? new Date(day * 864e5).toISOString().slice(0, 10) : null;

    // Holder Flow bubbles and radar whales on that day
    const hf: any[] = [], wh: any[] = [];
    if (day != null) for (const [t, m] of netBy) {
      const b = m.get(day), p = priceOf.get(t + dayStr);
      if (!b || !p) continue;
      const n100 = top100(b);
      if (n100 != null && n100 !== 0) {
        const held = top100(balBy.get(t)?.get(day));
        hf.push({ t, usd: n100 * p, coins: n100, pct: held ? 100 * n100 / Math.max(held - n100, 1e-9) : null });
      }
      const w = b.whale_ex ?? sum(b, ["1-10", "11-50"]);
      if (w != null && w !== 0) wh.push({ t, usd: w * p, coins: w, ex: b.whale_ex != null });
    }
    const up = (a: any[]) => a.filter((x) => x.usd > 0).sort((x, y) => y.usd - x.usd).slice(0, 10);
    const down = (a: any[]) => a.filter((x) => x.usd < 0).sort((x, y) => x.usd - y.usd).slice(0, 10);

    // Smart Bands: price above realized
    const sb: any[] = [];
    const lastN = Math.round(Date.now() / 864e5) - 1;
    const { data: btcRow } = await db.from("market_lists").select("data").eq("key", "btc_bands").maybeSingle();
    const tokens = [...balBy.keys()].filter((t) => [...balBy.get(t)!.values()].filter((b) => top100(b) != null).length >= MIN_DAYS || t === "BTC");
    for (const t of tokens) {
      try {
        const k = await klines(t); await sleep(120);
        const closeOf = (n: number) => k.get(n)?.c ?? null;
        let R: Map<number, number> | null = null, real = false;
        if (t === "BTC" && (btcRow?.data as any)?.rows?.length) {
          R = new Map(((btcRow!.data as any).rows as any[]).map((r) => [dn(r[0]), +r[1]])); real = true;
        } else {
          const net = new Map<number, number>(), bal = new Map<number, number>(), price = new Map<number, number>();
          for (const [n, b] of netBy.get(t) ?? []) { const v = top100(b); if (v != null) net.set(n, v); }
          for (const [n, b] of balBy.get(t) ?? []) { const v = top100(b); if (v != null) bal.set(n, v); }
          for (const d of daily) if (d.token === t && d.price) price.set(dn(d.day), +d.price);
          const r = realized(net, bal, price, k, lastN);
          if (!r || r.days < MIN_DAYS) continue;
          R = r.R;
        }
        const rDays = [...R.keys()].sort((a, b) => a - b), lastR = rDays[rDays.length - 1];
        const lastK = [...k.keys()].sort((a, b) => b - a)[0];
        const price = lastK != null ? k.get(lastK)!.c : priceOf.get(t + dayStr) ?? null;
        const r = R.get(lastR)!;
        if (!price || !r) continue;
        // Days since the close last moved from below to above the realized price
        let since: string | null = null;
        for (let i = rDays.length - 1; i > 0; i--) {
          const c = closeOf(rDays[i]), c0 = closeOf(rDays[i - 1]);
          if (c == null || c0 == null) continue;
          if (c > R.get(rDays[i])! && c0 <= R.get(rDays[i - 1])!) { since = new Date(rDays[i] * 864e5).toISOString().slice(0, 10); break; }
          if (c <= R.get(rDays[i])!) break;
        }
        sb.push({ t, price, realized: r, pct: 100 * (price / r - 1), since, real, days: R.size });
      } catch (e) { errors[t] = String(e).slice(0, 80); }
    }
    const above = sb.filter((x) => x.pct > 0).sort((x, y) => y.pct - x.pct).slice(0, 10);
    const data = { at: new Date().toISOString(), day: dayStr,
      hf: { up: up(hf), down: down(hf) }, whale: { up: up(wh), down: down(wh) },
      sb: { above, checked: sb.length, below: sb.filter((x) => x.pct <= 0).length } };
    const { error } = await db.from("market_lists").upsert({ key: "tops", data, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    const result = { day: dayStr, hf: [data.hf.up.length, data.hf.down.length], whale: [data.whale.up.length, data.whale.down.length], sb_checked: sb.length, sb_above: above.length, errors };
    await db.from("collector_state").upsert({ key: "tops_status", value: { at: new Date().toISOString(), ms: Date.now() - started, result }, updated_at: new Date().toISOString() });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e).slice(0, 200);
    await db.from("collector_state").upsert({ key: "tops_status", value: { at: new Date().toISOString(), ms: Date.now() - started, error: msg }, updated_at: new Date().toISOString() });
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});

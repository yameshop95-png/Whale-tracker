// Momentum radar: once a day (pg_cron, after the Sydney daily candle closes) score ~200 large coins on
// five 0-100 scores and a state, for each of the last 31 closed days (so the page can show how a
// coin's state moved). Data: CoinGecko (universe, names), daily spot candles of Binance, OKX and Bybit
// (price from one exchange, volume flows summed over the three, taker buys from Binance). Scoring lives
// in engine.ts.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { type Candle, parts, scoreDay, stateOf, ema, rsi, signedAdx } from "./engine.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const UNIVERSE = 200;
const HISTORY = 230;     // daily candles per coin (EMA100 + 90-day windows + 31 scored days)
const DAYS = 31;         // scored days stored per run
const KEEP_DAYS = 120;
const ENGINE = 6;      // bump when scoring/state rules change: the next call re-scores the stored days
const STABLE = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "USDS", "USDD", "PYUSD", "FRAX", "BUSD", "USDP", "RLUSD", "USD1", "USDTB", "EURC", "USDF", "USDG", "BFUSD", "GHO"]);
const WRAPPED = /wrapped|staked|restaked|bridged|liquid staking|binance-peg/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Days are Sydney days (AEST/AEDT). Binance cuts daily candles at the offset it is given; the offset of
// the moment of the run is used for the whole series, so days before a daylight-saving change are
// shifted by one hour.
const TZ = "Australia/Sydney";
function tzOffMin(t = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60000) * 60000) / 60000);
}
const OFF = tzOffMin(), OFF_MS = OFF * 60000;
const TZ_PARAM = (OFF < 0 ? "-" : "+") + String(Math.floor(Math.abs(OFF) / 60)).padStart(2, "0") + ":" + String(Math.abs(OFF) % 60).padStart(2, "0");
const dayOf = (t: number) => new Date(t + OFF_MS).toISOString().slice(0, 10);
async function getJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

// Spot USDT pairs listed on each exchange (a failed list just leaves that exchange out of the run)
async function listings() {
  const [bn, okx, by] = await Promise.all([
    getJson("https://data-api.binance.vision/api/v3/ticker/price").then((t: any[]) => new Set(t.map((x) => String(x.symbol)).filter((s) => s.endsWith("USDT")).map((s) => s.slice(0, -4)))).catch(() => new Set<string>()),
    getJson("https://www.okx.com/api/v5/market/tickers?instType=SPOT").then((t: any) => new Set((t?.data ?? []).map((x: any) => String(x.instId)).filter((s: string) => s.endsWith("-USDT")).map((s: string) => s.slice(0, -5)))).catch(() => new Set<string>()),
    getJson("https://api.bybit.com/v5/market/tickers?category=spot").then((t: any) => new Set((t?.result?.list ?? []).map((x: any) => String(x.symbol)).filter((s: string) => s.endsWith("USDT")).map((s: string) => s.slice(0, -4)))).catch(() => new Set<string>()),
  ]);
  return { binance: bn as Set<string>, okx: okx as Set<string>, bybit: by as Set<string> };
}
let LIST: Awaited<ReturnType<typeof listings>>;

async function universe() {
  // Two pages of 250 by market cap: after stablecoins, wrapped tokens and coins without a USDT pair on
  // Binance, OKX or Bybit are dropped, about 200 remain. CoinGecko throttles shared IPs, so the calls are spaced.
  const cg = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250";
  LIST = await listings();
  const page1 = await getJson(cg + "&page=1");
  await sleep(2500);
  const page2 = await getJson(cg + "&page=2").catch(() => []);
  await sleep(2500);
  const stables = await getJson(cg + "&page=1&category=stablecoins").catch(() => []);
  const all = [...(page1 as any[]), ...(page2 as any[])];
  const stableIds = new Set((stables as any[]).map((c) => c.id));
  const seen = new Set<string>(), out: any[] = [];
  for (const c of all as any[]) {
    const sym = String(c.symbol).toUpperCase();
    if (stableIds.has(c.id) || STABLE.has(sym) || WRAPPED.test(c.name) || seen.has(sym) || !/^[A-Z0-9]{2,12}$/.test(sym)) continue;
    if (!LIST.binance.has(sym) && !LIST.okx.has(sym) && !LIST.bybit.has(sym)) continue;   // scored from exchange candles
    seen.add(sym);
    // total_volume: 24h volume over all exchanges CoinGecko tracks (no extra request)
    out.push({ sym, name: String(c.name).slice(0, 40), image: String(c.image ?? ""), mcap: +c.market_cap || null, volAll: +c.total_volume || null, cgPrice: +c.current_price || null });
    if (out.length >= UNIVERSE) break;
  }
  return out;
}

// One exchange's closed daily candles keyed by Sydney day. Binance cuts days at the Sydney offset and reports
// taker buys; OKX and Bybit only offer UTC days, and a UTC day is filed under the Sydney day that ends 13 h
// (11 h in winter) after it closes, so their flows lag by part of a day (fine for 7–30-day sums).
type Day = { t: number; o: number; h: number; l: number; c: number; v: number; qv: number; tb: number | null };
async function binanceDays(sym: string): Promise<Map<string, Day>> {
  const rows = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1d&limit=${HISTORY}&timeZone=${encodeURIComponent(TZ_PARAM)}`);
  // [openTime, o, h, l, c, baseVol, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, _]
  return new Map((rows as any[]).filter((k) => k[6] < Date.now())   // closed days only
    .map((k) => [dayOf(k[0]), { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7], tb: +k[9] }]));
}
const utcToSydney = (t: number) => { const d = new Date(t + 86400e3); return d.toISOString().slice(0, 10); };
let okxNext = 0;   // OKX allows 20 candle requests per 2 s per IP: one every 120 ms
async function okxDays(sym: string): Promise<Map<string, Day>> {
  const wait = okxNext - Date.now(); okxNext = Math.max(Date.now(), okxNext) + 120; if (wait > 0) await sleep(wait);
  const j: any = await getJson(`https://www.okx.com/api/v5/market/candles?instId=${sym}-USDT&bar=1Dutc&limit=${HISTORY}`);
  // [ts, o, h, l, c, vol (base), volCcy, volCcyQuote, confirm]
  return new Map((j?.data ?? []).filter((k: any[]) => k[8] === "1").map((k: any[]) => [utcToSydney(+k[0]),
    { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7], tb: null }]));
}
async function bybitDays(sym: string): Promise<Map<string, Day>> {
  const j: any = await getJson(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}USDT&interval=D&limit=${HISTORY}`);
  // [start, o, h, l, c, volume (base), turnover]; the newest (still open) day is dropped
  return new Map((j?.result?.list ?? []).filter((k: any[]) => +k[0] + 86400e3 <= Date.now()).map((k: any[]) => [utcToSydney(+k[0]),
    { t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[6], tb: null }]));
}

// Candles of one coin over Binance + OKX + Bybit. Price comes from the exchange with the longest history
// (Binance when it has enough); volume flows (CMF, OBV) add every exchange, each on its own candle; taker
// buys only exist on Binance. An exchange whose last close is > 15% off CoinGecko's price is another coin
// under the same ticker and is left out.
async function candles(c: { sym: string; cgPrice: number | null }): Promise<{ k: Candle[]; ex: string[] }> {
  const jobs: [string, Promise<Map<string, Day>>][] = [];
  if (LIST.binance.has(c.sym)) jobs.push(["binance", binanceDays(c.sym)]);
  if (LIST.okx.has(c.sym)) jobs.push(["okx", okxDays(c.sym)]);
  if (LIST.bybit.has(c.sym)) jobs.push(["bybit", bybitDays(c.sym)]);
  const got: [string, Map<string, Day>][] = [];
  for (const [ex, p] of jobs) {
    const m = await p.catch(() => null);
    if (!m?.size) continue;
    const last = [...m.values()].sort((a, b) => b.t - a.t)[0];
    if (c.cgPrice && Math.abs(last.c / c.cgPrice - 1) > 0.15) continue;
    got.push([ex, m]);
  }
  if (!got.length) return { k: [], ex: [] };
  const bn = got.find(([ex]) => ex === "binance");
  const primary = bn && bn[1].size >= 120 ? bn : got.slice().sort((a, b) => b[1].size - a[1].size)[0];
  const days = [...primary[1].keys()].sort();
  const prevClose = new Map(got.map(([ex, m]) => { const ds = [...m.keys()].sort(); return [ex, new Map(ds.map((d, i) => [d, i ? m.get(ds[i - 1])!.c : null]))]; }));
  const k: Candle[] = days.map((d) => {
    const p = primary[1].get(d)!;
    let v = 0, qv = 0, mfv = 0, sv = 0, tn = 0, tv = 0;
    for (const [ex, m] of got) {
      const x = m.get(d); if (!x) continue;
      v += x.v; qv += x.qv;
      mfv += (x.h > x.l ? ((x.c - x.l) - (x.h - x.c)) / (x.h - x.l) : 0) * x.v;
      const pc = prevClose.get(ex)!.get(d);
      sv += pc == null ? 0 : x.c > pc ? x.v : x.c < pc ? -x.v : 0;
      if (x.tb !== null) { tn += 2 * x.tb - x.v; tv += x.v; }
    }
    return { t: dayStart(d), o: p.o, h: p.h, l: p.l, c: p.c, v, qv, tb: 0, mfv, sv, tn, tv };
  });
  return { k, ex: got.map(([ex]) => ex) };
}
// Start of a Sydney day (UTC ms), the key the scoring loop uses
const dayStart = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - OFF_MS;

// Only pg_cron may start a run: it sends the shared secret kept in Supabase Vault (see the
// cron_secret migration); anyone else calling the public URL gets 401 and costs nothing.
async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now();
  const dayMs = 86400e3, lastClosed = Math.floor((Date.now() + OFF_MS) / dayMs) * dayMs - OFF_MS - dayMs;   // start of the last closed Sydney day
  const lastDay = dayOf(lastClosed);
  // Once a day: the URL is public, so a repeat call only reads the database
  const { count } = await db.from("momentum_daily").select("*", { count: "exact", head: true }).eq("day", lastDay);
  const { data: st } = await db.from("collector_state").select("value").eq("key", "momentum_status").maybeSingle();
  if ((count ?? 0) >= 50 && (st?.value as any)?.engine === ENGINE) return Response.json({ ok: true, skipped: `already scored ${lastDay}` });

  const coins = await universe();
  const data = new Map<string, Candle[]>(), failed: string[] = [], exCount: Record<string, number> = {};
  for (let i = 0; i < coins.length; i += 8) {   // 8 at a time; each Binance request weighs 2 of its 6,000/min
    await Promise.all(coins.slice(i, i + 8).map(async (c) => {
      try {
        const { k, ex } = await candles(c);
        if (k.length >= 60) { data.set(c.sym, k); const key = ex.join("+"); exCount[key] = (exCount[key] ?? 0) + 1; } else failed.push(c.sym);
      } catch { failed.push(c.sym); }
    }));
    await sleep(150);
  }
  const listed = coins.filter((c) => data.has(c.sym));
  // Indicators once per coin, then parts for each scored day (by date, coins have different histories)
  const pre = new Map(listed.map((c) => {
    const k = data.get(c.sym)!, cl = k.map((x) => x.c);
    return [c.sym, { e20: ema(cl, 20), e50: ema(cl, 50), e100: ema(cl, 100), r14: rsi(cl, 14), adx: signedAdx(k, 14),
      at: new Map(k.map((x, i) => [x.t, i])) }];
  }));
  const rows: any[] = [];
  for (let d = DAYS - 1; d >= 0; d--) {
    const t = lastClosed - d * dayMs, day = dayOf(t);
    const present = listed.filter((c) => pre.get(c.sym)!.at.has(t));
    const raw = present.map((c) => parts(data.get(c.sym)!, pre.get(c.sym)!.at.get(t)!, pre.get(c.sym)!));
    const scores = scoreDay(raw);
    present.forEach((c, j) => {
      const s = scores[j];
      if (!s) return;
      const k = data.get(c.sym)!, i = pre.get(c.sym)!.at.get(t)!;
      rows.push({ token: c.sym, day, rank: coins.indexOf(c) + 1, name: c.name, image: c.image, price: k[i].c,
        chg: i ? k[i].c / k[i - 1].c - 1 : null, vol: k[i].qv, mcap: d === 0 ? c.mcap : null, ...s, state: stateOf(s, raw[j]),
        // Raw parts on the latest day, so the page can explain a score
        parts: d === 0 ? { ...Object.fromEntries(Object.entries(raw[j]).map(([p, v]) => [p, v === null ? null : Math.round(v * 1e4) / 1e4])), vol_all: c.volAll } : null });
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("momentum_daily").upsert(rows.slice(i, i + 500));
    if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  const cutoff = dayOf(lastClosed - KEEP_DAYS * dayMs);
  await db.from("momentum_daily").delete().lt("day", cutoff);
  const status = { at: new Date().toISOString(), engine: ENGINE, day: lastDay, coins: listed.length, rows: rows.length, failed, exchanges: exCount, ms: Date.now() - started };
  await db.from("collector_state").upsert({ key: "momentum_status", value: status, updated_at: new Date().toISOString() });
  return Response.json({ ok: true, ...status });
});

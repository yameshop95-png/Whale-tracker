// Momentum radar: once a day (pg_cron, after the UTC daily candle closes) score ~100 large coins on
// five 0-100 scores and a state, for each of the last 31 closed days (so the page can show how a
// coin's state moved). Data: CoinGecko (universe, names), Binance spot daily candles (price,
// volume, taker-buy volume). Scoring lives in engine.ts.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { type Candle, parts, scoreDay, stateOf, ema, rsi, signedAdx } from "./engine.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const UNIVERSE = 100;
const HISTORY = 230;     // daily candles per coin (EMA100 + 90-day windows + 31 scored days)
const DAYS = 31;         // scored days stored per run
const KEEP_DAYS = 120;
const ENGINE = 3;        // bump when scoring/state rules change: the next call re-scores the stored days
const STABLE = new Set(["USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "USDS", "USDD", "PYUSD", "FRAX", "BUSD", "USDP", "RLUSD", "USD1", "USDTB", "EURC", "USDF", "USDG", "BFUSD", "GHO"]);
const WRAPPED = /wrapped|staked|restaked|bridged|liquid staking|binance-peg/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

async function universe() {
  const cg = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1";
  const [all, stables, tickers] = await Promise.all([
    getJson(cg), getJson(cg + "&category=stablecoins").catch(() => []), getJson("https://data-api.binance.vision/api/v3/ticker/price"),
  ]);
  const stableIds = new Set((stables as any[]).map((c) => c.id));
  const binance = new Set((tickers as any[]).map((t) => t.symbol));
  const seen = new Set<string>(), out: any[] = [];
  for (const c of all as any[]) {
    const sym = String(c.symbol).toUpperCase();
    if (stableIds.has(c.id) || STABLE.has(sym) || WRAPPED.test(c.name) || seen.has(sym) || !/^[A-Z0-9]{2,12}$/.test(sym)) continue;
    if (!binance.has(sym + "USDT")) continue;   // scored from Binance candles
    seen.add(sym);
    // total_volume: 24h volume over all exchanges CoinGecko tracks (no extra request)
    out.push({ sym, name: String(c.name).slice(0, 40), image: String(c.image ?? ""), mcap: +c.market_cap || null, volAll: +c.total_volume || null });
    if (out.length >= UNIVERSE) break;
  }
  return out;
}

async function candles(sym: string): Promise<Candle[]> {
  const rows = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1d&limit=${HISTORY}`);
  // [openTime, o, h, l, c, baseVol, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, _]
  return (rows as any[]).filter((k) => k[6] < Date.now())   // closed days only
    .map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], qv: +k[7], tb: +k[9] }));
}

Deno.serve(async () => {
  const started = Date.now();
  const dayMs = 86400e3, lastClosed = Math.floor(Date.now() / dayMs) * dayMs - dayMs;
  const lastDay = new Date(lastClosed).toISOString().slice(0, 10);
  // Once a day: the URL is public, so a repeat call only reads the database
  const { count } = await db.from("momentum_daily").select("*", { count: "exact", head: true }).eq("day", lastDay);
  const { data: st } = await db.from("collector_state").select("value").eq("key", "momentum_status").maybeSingle();
  if ((count ?? 0) >= 50 && (st?.value as any)?.engine === ENGINE) return Response.json({ ok: true, skipped: `already scored ${lastDay}` });

  const coins = await universe();
  const data = new Map<string, Candle[]>(), failed: string[] = [];
  for (let i = 0; i < coins.length; i += 8) {   // 8 at a time; each request weighs 2 of Binance's 6,000/min
    await Promise.all(coins.slice(i, i + 8).map(async (c) => {
      try { const k = await candles(c.sym); if (k.length >= 60) data.set(c.sym, k); else failed.push(c.sym); }
      catch { failed.push(c.sym); }
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
    const t = lastClosed - d * dayMs, day = new Date(t).toISOString().slice(0, 10);
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
  const cutoff = new Date(lastClosed - KEEP_DAYS * dayMs).toISOString().slice(0, 10);
  await db.from("momentum_daily").delete().lt("day", cutoff);
  const status = { at: new Date().toISOString(), engine: ENGINE, day: lastDay, coins: listed.length, rows: rows.length, failed, ms: Date.now() - started };
  await db.from("collector_state").upsert({ key: "momentum_status", value: status, updated_at: new Date().toISOString() });
  return Response.json({ ok: true, ...status });
});

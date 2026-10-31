// Whale Tracker collector. pg_cron calls this every minute.
// - OKX, Bybit, Coinbase, Gate, KuCoin, Kraken, Crypto.com, LBank, HTX, MEXC, Bitget, Upbit: recent trades (each carries its side) -> per-minute taker buy/sell volume
// - Sei EVM (Etherscan API V2): DEX buys/sells of SEI -> per-minute DEX volume + whale trades
// - Ethereum (Alchemy): large ETH/USDT/USDC transfers, classified as exchange inflow/outflow
// Binance is not stored: the website reads its klines directly, which already have history.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const ETHERSCAN_KEY = Deno.env.get("ETHERSCAN_API_KEY") ?? "";
const ALCHEMY_KEY = Deno.env.get("ALCHEMY_API_KEY") ?? "";

const ROUNDS = 3;               // CEX polls per run, spread over the minute
const ROUND_GAP_MS = 18000;
const UNSUPPORTED_RETRY_MS = 6 * 3600 * 1000;
const DEX_WHALE_MIN_USD = 1000;
// Pause between two requests to the same exchange within a round (ms)
const EX_GAP_MS: Record<string, number> = { bitget: 150, kraken: 300, coinbase: 150, upbit: 150, kucoin: 150 };
const ETH_WHALE_MIN_USD = 1_000_000;

type Side = "buy" | "sell";
type Trade = { id: string; t: number; side: Side; base: number; usd: number };
type Fetched = { trades: Trade[]; limit: number } | { unsupported: true };
type Cursor = { ts: number; ids: string[] };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minuteIso = (t: number) => new Date(Math.floor(t / 60000) * 60000).toISOString();
// Errors end up in the public status row; a network error can quote the request URL, and the
// Etherscan/Alchemy URLs carry the API keys, so scrub them first
const SECRETS = [ETHERSCAN_KEY, ALCHEMY_KEY].filter((s) => s.length > 6);
const errMsg = (e: unknown) => {
  let m = (e instanceof Error ? e.message : String(e)).replace(/(api[-_]?key=)[^&\s)"']+/gi, "$1***");
  for (const s of SECRETS) m = m.split(s).join("***");
  return m.slice(0, 200);
};

async function getJson(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text as unknown };
  }
}

async function loadState(keys: string[]): Promise<Record<string, any>> {
  const { data, error } = await db.from("collector_state").select("key,value").in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}

async function saveState(entries: Record<string, unknown>) {
  const now = new Date().toISOString();
  const rows = Object.entries(entries).map(([key, value]) => ({ key, value, updated_at: now }));
  const { error } = await db.from("collector_state").upsert(rows);
  if (error) throw error;
}

// ---------------- CEX ----------------
const CEX: Record<string, (sym: string, usdPrice: number) => Promise<Fetched>> = {
  async okx(sym) {
    const { body } = await getJson(`https://www.okx.com/api/v5/market/trades?instId=${sym}-USDT&limit=500`);
    if (body?.code === "51001") return { unsupported: true };            // instrument doesn't exist
    if (body?.code !== "0") throw new Error(`okx ${body?.code ?? ""} ${body?.msg ?? JSON.stringify(body).slice(0, 80)}`);
    return {
      limit: 500,
      trades: body.data.map((t: any) => ({
        id: String(t.tradeId), t: +t.ts, side: t.side === "buy" ? "buy" : "sell", base: +t.sz, usd: +t.sz * +t.px,
      })),
    };
  },
  async bybit(sym) {
    const { body } = await getJson(`https://api.bybit.com/v5/market/recent-trade?category=spot&symbol=${sym}USDT&limit=60`);
    if (body?.retCode === 10001) return { unsupported: true };           // symbol not supported
    if (body?.retCode !== 0) throw new Error(`bybit ${body?.retCode ?? ""} ${body?.retMsg ?? JSON.stringify(body).slice(0, 80)}`);
    return {
      limit: 60,
      trades: body.result.list.map((t: any) => ({
        id: String(t.execId), t: +t.time, side: t.side === "Buy" ? "buy" : "sell", base: +t.size, usd: +t.size * +t.price,
      })),
    };
  },
  async coinbase(sym) {
    const { status, body } = await getJson(`https://api.exchange.coinbase.com/products/${sym}-USD/trades?limit=1000`, {
      headers: { "User-Agent": "whale-tracker" },
    });
    if (status === 404) return { unsupported: true };
    if (!Array.isArray(body)) throw new Error(`coinbase ${status} ${JSON.stringify(body).slice(0, 80)}`);
    // Coinbase reports the MAKER's side: "buy" means a resting buy was hit, i.e. the taker sold
    return {
      limit: 1000,
      trades: body.map((t: any) => ({
        id: String(t.trade_id), t: Date.parse(t.time), side: t.side === "buy" ? "sell" : "buy", base: +t.size, usd: +t.size * +t.price,
      })),
    };
  },
  async gate(sym) {
    const { status, body } = await getJson(`https://api.gateio.ws/api/v4/spot/trades?currency_pair=${sym}_USDT&limit=1000`);
    if (status === 400 && /INVALID_CURRENCY/.test(body?.label ?? "")) return { unsupported: true };
    if (!Array.isArray(body)) throw new Error(`gate ${status} ${JSON.stringify(body).slice(0, 80)}`);
    return {
      limit: 1000,
      trades: body.map((t: any) => ({
        id: String(t.id), t: Math.floor(+t.create_time_ms), side: t.side === "buy" ? "buy" : "sell", base: +t.amount, usd: +t.amount * +t.price,
      })),
    };
  },
  async kucoin(sym) {
    const { body } = await getJson(`https://api.kucoin.com/api/v1/market/histories?symbol=${sym}-USDT`);
    if (body?.code !== "200000" || !Array.isArray(body.data)) throw new Error(`kucoin ${body?.code ?? ""} ${body?.msg ?? JSON.stringify(body).slice(0, 80)}`);
    // An unlisted pair returns an empty list (a listed one always has its last trades)
    if (!body.data.length) return { unsupported: true };
    return {
      limit: 100,
      trades: body.data.map((t: any) => ({
        // `side` is the taker's side; time is in nanoseconds
        id: String(t.sequence), t: Math.floor(+t.time / 1e6), side: t.side === "buy" ? "buy" : "sell", base: +t.size, usd: +t.size * +t.price,
      })),
    };
  },
  async kraken(sym) {
    const pair = (sym === "BTC" ? "XBT" : sym) + "USD";   // Kraken calls bitcoin XBT
    const { body } = await getJson(`https://api.kraken.com/0/public/Trades?pair=${pair}&count=1000`);
    if ((body?.error ?? []).some((e: string) => /Unknown asset pair/.test(e))) return { unsupported: true };
    if (body?.error?.length || !body?.result) throw new Error(`kraken ${JSON.stringify(body?.error ?? body).slice(0, 80)}`);
    // The result is keyed by Kraken's own pair name (e.g. XETHZUSD), next to "last"
    const list = Object.entries(body.result).find(([k]) => k !== "last")?.[1] as any[] ?? [];
    return {
      limit: 1000,
      trades: list.map((t: any) => ({
        // [price, volume, time(s), "b"|"s" taker side, type, misc, trade_id]
        id: String(t[6]), t: Math.floor(+t[2] * 1000), side: t[3] === "b" ? "buy" : "sell", base: +t[1], usd: +t[1] * +t[0],
      })),
    };
  },
  async cryptocom(sym) {
    const { status, body } = await getJson(`https://api.crypto.com/exchange/v1/public/get-trades?instrument_name=${sym}_USDT&count=150`);
    if (status === 400 && body?.code === 40004) return { unsupported: true };   // invalid instrument
    if (body?.code !== 0 || !Array.isArray(body?.result?.data)) throw new Error(`cryptocom ${status} ${JSON.stringify(body).slice(0, 80)}`);
    return {
      limit: 150,
      trades: body.result.data.map((t: any) => ({
        id: String(t.d), t: +t.t, side: String(t.s).toLowerCase() === "buy" ? "buy" : "sell", base: +t.q, usd: +t.q * +t.p,
      })),
    };
  },
  async lbank(sym) {
    const { body } = await getJson(`https://api.lbkex.com/v2/trades.do?symbol=${sym.toLowerCase()}_usdt&size=600`);
    if (body?.error_code === 10008) return { unsupported: true };              // currency pair not supported
    if (body?.result !== "true" || !Array.isArray(body.data)) throw new Error(`lbank ${JSON.stringify(body).slice(0, 80)}`);
    return {
      limit: 600,
      trades: body.data.map((t: any) => ({
        id: String(t.tid), t: +t.date_ms, side: String(t.type).startsWith("buy") ? "buy" : "sell", base: +t.amount, usd: +t.amount * +t.price,
      })),
    };
  },
  async htx(sym) {
    const { body } = await getJson(`https://api.huobi.pro/market/history/trade?symbol=${sym.toLowerCase()}usdt&size=500`);
    if (body?.status === "error" && body?.["err-code"] === "invalid-parameter") return { unsupported: true };
    if (body?.status !== "ok" || !Array.isArray(body.data)) throw new Error(`htx ${JSON.stringify(body).slice(0, 80)}`);
    // Grouped by match: each group holds one or more fills; `direction` is the taker's side
    const trades = body.data.flatMap((g: any) => g.data ?? []).map((t: any) => ({
      id: String(t["trade-id"]), t: +t.ts, side: t.direction === "buy" ? "buy" : "sell", base: +t.amount, usd: +t.amount * +t.price,
    })) as Trade[];
    // The page limit counts groups, so the response is "full" when it returned 500 groups
    return { limit: body.data.length >= 500 ? trades.length : trades.length + 1, trades };
  },
  async mexc(sym) {
    const { status, body } = await getJson(`https://api.mexc.com/api/v3/trades?symbol=${sym}USDT&limit=1000`);
    if (status === 400 && body?.code === -1121) return { unsupported: true };   // invalid symbol
    if (!Array.isArray(body)) throw new Error(`mexc ${status} ${JSON.stringify(body).slice(0, 80)}`);
    // MEXC returns id: null, so build one from the trade's fields (plus a counter for exact repeats)
    const seen = new Map<string, number>();
    return {
      limit: 1000,
      trades: body.map((t: any) => {
        const key = `${t.time}:${t.price}:${t.qty}:${t.isBuyerMaker ? 1 : 0}`;
        const k = (seen.get(key) ?? 0) + 1;
        seen.set(key, k);
        // isBuyerMaker: the resting order was the buy, so the taker sold
        return { id: `${key}:${k}`, t: +t.time, side: t.isBuyerMaker ? "sell" : "buy", base: +t.qty, usd: +t.quoteQty || +t.qty * +t.price };
      }),
    };
  },
  async bitget(sym) {
    const { status, body } = await getJson(`https://api.bitget.com/api/v2/spot/market/fills?symbol=${sym}USDT&limit=500`);
    if (status === 400 && body?.code === "40034") return { unsupported: true };  // symbol does not exist
    if (body?.code !== "00000" || !Array.isArray(body.data)) throw new Error(`bitget ${status} ${JSON.stringify(body).slice(0, 80)}`);
    return {
      limit: 500,
      trades: body.data.map((t: any) => ({
        id: String(t.tradeId), t: +t.ts, side: t.side === "buy" ? "buy" : "sell", base: +t.size, usd: +t.size * +t.price,
      })),
    };
  },
  async upbit(sym, usdPrice) {
    const { status, body } = await getJson(`https://api.upbit.com/v1/trades/ticks?market=KRW-${sym}&count=500`);
    if (status === 404 || (body?.error && status < 500)) return { unsupported: true };
    if (!Array.isArray(body)) throw new Error(`upbit ${status} ${JSON.stringify(body).slice(0, 80)}`);
    // KRW market: value in USD via the coin's USD price (no FX rate needed)
    return {
      limit: 500,
      trades: body.map((t: any) => ({
        // REST ticks use `timestamp`; the WebSocket feed calls it `trade_timestamp`
        id: String(t.sequential_id), t: +(t.timestamp ?? t.trade_timestamp), side: t.ask_bid === "BID" ? "buy" : "sell",
        base: +t.trade_volume, usd: +t.trade_volume * usdPrice,
      })),
    };
  },
};

// Returns per-minute rows for trades not seen before and advances the cursor.
// partial = the response was full and still didn't reach back to the last seen trade.
function takeNew(sym: string, ex: string, f: { trades: Trade[]; limit: number }, cursors: Record<string, Cursor>) {
  const key = `${ex}:${sym}`, cur = cursors[key];
  const trades = f.trades.filter((t) => t.t > 0 && t.base > 0);
  if (!trades.length) return [];
  const maxTs = Math.max(...trades.map((t) => t.t));
  const idsAtMax = trades.filter((t) => t.t === maxTs).map((t) => t.id);
  cursors[key] = { ts: maxTs, ids: cur && cur.ts === maxTs ? [...new Set([...cur.ids, ...idsAtMax])] : idsAtMax };
  if (!cur) return [];   // first sight: only set the cursor, so no half-counted minute is stored

  const fresh = trades.filter((t) => t.t > cur.ts || (t.t === cur.ts && !cur.ids.includes(t.id)));
  const oldest = Math.min(...trades.map((t) => t.t));
  const gap = f.trades.length >= f.limit && oldest > cur.ts;
  const rows = new Map<string, any>();
  for (const t of fresh) {
    const m = minuteIso(t.t);
    const r = rows.get(m) ?? { symbol: sym, exchange: ex, minute: m, buy_base: 0, sell_base: 0, buy_usd: 0, sell_usd: 0, trades: 0, partial: false };
    if (t.side === "buy") { r.buy_base += t.base; r.buy_usd += t.usd; } else { r.sell_base += t.base; r.sell_usd += t.usd; }
    r.trades++;
    if (gap && t.t < oldest + 60000) r.partial = true;
    rows.set(m, r);
  }
  return [...rows.values()];
}

async function cexRound(symbols: string[], prices: Record<string, number>, cursors: Record<string, Cursor>,
                        unsupported: Record<string, number>, errors: Record<string, string>) {
  // Exchanges run in parallel; each exchange gets its symbols one after another with a small gap,
  // so a 20-coin watchlist stays under per-IP rate limits (Bitget answered 429 to a burst of 16)
  const jobs = Object.entries(CEX).map(async ([ex, fetcher]) => {
    const out: any[] = [];
    let first = true;
    for (const sym of symbols) {
      const key = `${ex}:${sym}`;
      if (unsupported[key] && unsupported[key] > Date.now()) continue;
      if (!first) await sleep(EX_GAP_MS[ex] ?? 100);
      first = false;
      try {
        const f = await fetcher(sym, prices[sym] ?? 0);
        if ("unsupported" in f) { unsupported[key] = Date.now() + UNSUPPORTED_RETRY_MS; delete cursors[key]; continue; }
        delete unsupported[key];
        delete errors[key];
        out.push(...takeNew(sym, ex, f, cursors));
      } catch (e) {
        errors[key] = errMsg(e);
      }
    }
    return out;
  });
  const rows = (await Promise.all(jobs)).flat();
  if (rows.length) {
    const { error } = await db.rpc("add_cex_trades", { rows });
    if (error) errors.db_cex = error.message;
  }
  return rows.length;
}

async function binancePrices(): Promise<Record<string, number>> {
  const { body } = await getJson("https://data-api.binance.vision/api/v3/ticker/price");
  if (!Array.isArray(body)) throw new Error("binance ticker " + JSON.stringify(body).slice(0, 80));
  const out: Record<string, number> = {};
  for (const p of body) if (p.symbol.endsWith("USDT")) out[p.symbol.slice(0, -4)] = +p.price;
  return out;
}

// ---------------- Sei EVM DEX (Etherscan API V2) ----------------
const WSEI = "0xe30fedd158a2e3b13e9badaeabafc5516e95e8c7";
const TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TOPIC_SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const TOPIC_SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const topicAddr = (t: string) => "0x" + t.slice(26).toLowerCase();

let lastEs = 0;
async function es(params: Record<string, string | number>) {
  const wait = lastEs + 350 - Date.now();   // free tier: ~3 calls/s
  if (wait > 0) await sleep(wait);
  lastEs = Date.now();
  const qs = new URLSearchParams({ chainid: "1329", ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), apikey: ETHERSCAN_KEY });
  const { body } = await getJson(`https://api.etherscan.io/v2/api?${qs}`);
  if (body?.error) throw new Error(body.error.message ?? "rpc error");
  if (body?.status === "0") {
    if (Array.isArray(body.result)) return [];   // "No records found"
    throw new Error(String(body.result ?? body.message));
  }
  return body.result;
}

async function esLogs(params: Record<string, string | number>, from: number, to: number) {
  const all: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await es({ module: "logs", action: "getLogs", fromBlock: from, toBlock: to, page, offset: 1000, ...params });
    all.push(...res);
    if (res.length < 1000) break;
  }
  return all;
}

async function collectSei(price: number) {
  if (!ETHERSCAN_KEY) return "no ETHERSCAN_API_KEY";
  const st = (await loadState(["sei_block"])).sei_block;
  const latest = parseInt(await es({ module: "proxy", action: "eth_blockNumber" }), 16);
  let from = st?.block ? st.block + 1 : latest - 150;
  let skipped = 0;
  if (latest - from > 3000) { skipped = latest - 3000 - from; from = latest - 3000; }   // after downtime, don't try to replay everything
  if (from > latest) return "up to date";

  const transfers = await esLogs({ address: WSEI, topic0: TOPIC_TRANSFER }, from, latest);
  let trades = 0, whales = 0;
  if (transfers.length) {
    const swaps = [...await esLogs({ topic0: TOPIC_SWAP_V2 }, from, latest), ...await esLogs({ topic0: TOPIC_SWAP_V3 }, from, latest)];
    // A swap tx emits Swap from each pool it touched. WSEI out of a pool = buy, into a pool = sell.
    // Netting per tx makes multi-hop routes (SEI in the middle) cancel out.
    const pools = new Map<string, Set<string>>();
    for (const s of swaps) {
      const set = pools.get(s.transactionHash) ?? new Set<string>();
      set.add(s.address.toLowerCase());
      pools.set(s.transactionHash, set);
    }
    const perTx = new Map<string, { net: number; time: number; trader: string }>();
    for (const t of transfers) {
      const p = pools.get(t.transactionHash);
      if (!p || t.topics.length < 3) continue;
      const fromA = topicAddr(t.topics[1]), toA = topicAddr(t.topics[2]);
      const fromPool = p.has(fromA), toPool = p.has(toA);
      if (fromPool === toPool) continue;
      const sei = Number(BigInt(t.data)) / 1e18;
      const x = perTx.get(t.transactionHash) ?? { net: 0, time: parseInt(t.timeStamp, 16) * 1000, trader: "" };
      x.net += fromPool ? sei : -sei;
      x.trader = fromPool ? toA : fromA;
      perTx.set(t.transactionHash, x);
    }
    const minutes = new Map<string, any>();
    const big: any[] = [];
    for (const [hash, x] of perTx) {
      if (Math.abs(x.net) < 1e-9) continue;
      const side: Side = x.net > 0 ? "buy" : "sell", sei = Math.abs(x.net);
      const m = minuteIso(x.time);
      const r = minutes.get(m) ?? { symbol: "SEI", minute: m, buy: 0, sell: 0, n: 0 };
      r[side] += sei; r.n++;
      minutes.set(m, r);
      trades++;
      if (sei * price >= DEX_WHALE_MIN_USD) {
        big.push({ id: `sei:${hash}`, symbol: "SEI", time: new Date(x.time).toISOString(), kind: side, asset: "SEI",
                   amount: sei, usd: sei * price, wallet: null, counterparty: x.trader, exchange: null, tx_hash: hash });
      }
    }
    // The pool's counterparty is usually a router; look up who signed the biggest ones.
    big.sort((a, b) => b.usd - a.usd);
    for (const w of big.slice(0, 5)) {
      if (w.usd < 5000) break;
      try {
        const tx = await es({ module: "proxy", action: "eth_getTransactionByHash", txhash: w.tx_hash });
        if (tx?.from) w.wallet = String(tx.from).toLowerCase();
      } catch { /* keep router as counterparty */ }
    }
    if (minutes.size) {
      const { error } = await db.rpc("add_dex_volume", { rows: [...minutes.values()] });
      if (error) throw error;
    }
    if (big.length) {
      const { error } = await db.from("whale_trades").upsert(big, { ignoreDuplicates: true });
      if (error) throw error;
      whales = big.length;
    }
  }
  await saveState({ sei_block: { block: latest } });
  return `blocks ${from}-${latest}, ${trades} trades, ${whales} whales${skipped ? `, skipped ${skipped} blocks` : ""}`;
}

// ---------------- Ethereum whales (Alchemy) ----------------
const ETH_EXCHANGES: Record<string, string> = {
  "0x28c6c06298d514db089934071355e5743bf21d60": "Binance",
  "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance",
  "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8": "Binance",
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "Coinbase",
  "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase",
  "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase",
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit",
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX",
  "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "Kraken",
};
const ETH_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6 },
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6 },
};

async function alchemy(method: string, params: unknown[]) {
  const { body } = await getJson(`https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body?.error) throw new Error(body.error.message);
  if (body?.result === undefined) throw new Error("alchemy " + JSON.stringify(body).slice(0, 80));
  return body.result;
}

function ethFlow(from: string, to: string) {
  const fx = ETH_EXCHANGES[from], tx = ETH_EXCHANGES[to];
  if (tx && !fx) return { kind: "in", exchange: tx };
  if (fx && !tx) return { kind: "out", exchange: fx };
  if (fx && tx) return { kind: "internal", exchange: fx };
  return { kind: "wallet", exchange: null };
}

async function collectEth(price: number) {
  if (!ALCHEMY_KEY) return "no ALCHEMY_API_KEY";
  const st = (await loadState(["eth_block"])).eth_block;
  const latest = parseInt(await alchemy("eth_blockNumber", []), 16);
  let from = st?.block ? st.block + 1 : latest - 4;
  if (latest - from > 20) from = latest - 20;
  if (from > latest) return "up to date";

  const rows: any[] = [];
  const times = new Map<number, number>();
  for (let b = from; b <= latest; b++) {
    const block = await alchemy("eth_getBlockByNumber", ["0x" + b.toString(16), true]);
    if (!block) continue;
    const time = parseInt(block.timestamp, 16) * 1000;
    times.set(b, time);
    if (!price) continue;
    for (const t of block.transactions) {
      if (!t.to) continue;
      const eth = Number(BigInt(t.value)) / 1e18, usd = eth * price;
      if (usd < ETH_WHALE_MIN_USD) continue;
      const fromA = t.from.toLowerCase(), toA = t.to.toLowerCase();
      rows.push({ id: `eth:${t.hash}`, symbol: "ETH", time: new Date(time).toISOString(), asset: "ETH", amount: eth, usd,
                  wallet: fromA, counterparty: toA, tx_hash: t.hash, ...ethFlow(fromA, toA) });
    }
  }
  const logs = await alchemy("eth_getLogs", [{
    fromBlock: "0x" + from.toString(16), toBlock: "0x" + latest.toString(16),
    address: Object.keys(ETH_TOKENS), topics: [TOPIC_TRANSFER],
  }]);
  for (const l of logs) {
    if (l.topics.length < 3 || l.data === "0x") continue;
    const tok = ETH_TOKENS[l.address.toLowerCase()];
    const amount = Number(BigInt(l.data)) / 10 ** tok.decimals;
    if (amount < ETH_WHALE_MIN_USD) continue;
    const fromA = topicAddr(l.topics[1]), toA = topicAddr(l.topics[2]);
    const time = times.get(parseInt(l.blockNumber, 16)) ?? Date.now();
    rows.push({ id: `eth:${l.transactionHash}:${parseInt(l.logIndex, 16)}`, symbol: "ETH", time: new Date(time).toISOString(),
                asset: tok.symbol, amount, usd: amount, wallet: fromA, counterparty: toA, tx_hash: l.transactionHash,
                ...ethFlow(fromA, toA) });
  }
  if (rows.length) {
    const { error } = await db.from("whale_trades").upsert(rows, { ignoreDuplicates: true });
    if (error) throw error;
  }
  await saveState({ eth_block: { block: latest } });
  return `blocks ${from}-${latest}, ${rows.length} whales`;
}

// ---------------- main ----------------
Deno.serve(async () => {
  const { data: ok, error: lockErr } = await db.rpc("try_start_run", { min_seconds: 50 });
  if (lockErr) return Response.json({ ok: false, error: lockErr.message }, { status: 500 });
  if (!ok) return Response.json({ ok: false, skipped: "another run is active" });

  const started = Date.now();
  const errors: Record<string, string> = {};
  const notes: Record<string, string> = {};
  try {
    const { data: wl, error: wlErr } = await db.from("watchlist").select("symbol,pinned");
    if (wlErr) throw wlErr;
    const symbols = (wl ?? []).map((w) => w.symbol);
    let prices: Record<string, number> = {};
    try { prices = await binancePrices(); } catch (e) { errors.prices = errMsg(e); }

    const st = await loadState(["cursors", "unsupported"]);
    const cursors: Record<string, Cursor> = st.cursors ?? {};
    const unsupported: Record<string, number> = st.unsupported ?? {};

    const onchain = Promise.all([
      collectSei(prices.SEI ?? 0).then((n) => { notes.sei = n; }, (e) => { errors.sei = errMsg(e); }),
      collectEth(prices.ETH ?? 0).then((n) => { notes.eth = n; }, (e) => { errors.eth = errMsg(e); }),
    ]);
    let cexRows = 0;
    for (let r = 0; r < ROUNDS; r++) {
      // Rounds start at fixed offsets (0s, 18s, 36s) so slower rounds don't push the run past a minute
      const wait = started + r * ROUND_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      cexRows += await cexRound(symbols, prices, cursors, unsupported, errors);
    }
    await onchain;
    notes.cex = `${cexRows} minute rows`;

    // Drop non-pinned coins that no tracked exchange lists
    for (const w of wl ?? []) {
      if (w.pinned || prices[w.symbol]) continue;
      if (Object.keys(CEX).every((ex) => (unsupported[`${ex}:${w.symbol}`] ?? 0) > Date.now())) {
        await db.from("watchlist").delete().eq("symbol", w.symbol);
        notes[`removed:${w.symbol}`] = "not listed on any tracked exchange";
      }
    }
    await saveState({ cursors, unsupported });
    if (new Date().getUTCMinutes() === 0) {
      const { error } = await db.rpc("cleanup_old");
      if (error) errors.cleanup = error.message;
    }
    const unsupportedNow = Object.entries(unsupported).filter(([, until]) => until > Date.now()).map(([k]) => k);
    await saveState({
      status: {
        at: new Date().toISOString(), ms: Date.now() - started, symbols, errors, notes, unsupported: unsupportedNow,
        keys: { etherscan: !!ETHERSCAN_KEY, alchemy: !!ALCHEMY_KEY },
      },
    });
    return Response.json({ ok: true, ms: Date.now() - started, errors, notes });
  } catch (e) {
    const msg = errMsg(e);
    await saveState({ status: { at: new Date().toISOString(), ms: Date.now() - started, errors: { ...errors, fatal: msg }, notes } }).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});

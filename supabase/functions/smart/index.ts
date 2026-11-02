// Smart money + CryptoQuant. pg_cron calls this every 5 minutes.
// - Discovery (first run each hour): wallets behind large trades on verified DEX pools
//   (GeckoTerminal: Uniswap on Ethereum, Raydium on Solana) and large Sei DEX trades.
// - Tracking: transfers of followed wallets on Ethereum and Sei (Etherscan API V2) and Solana
//   (SOLANA_RPC_URL). Only verified tokens are valued, since whale wallets get spammed with
//   look-alike USDT/USDC airdrops.
// - CryptoQuant (first run each hour, when CRYPTOQUANT_API_KEY is set) into cq_metrics.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const ETHERSCAN_KEY = Deno.env.get("ETHERSCAN_API_KEY") ?? "";
const SOLANA_RPC = Deno.env.get("SOLANA_RPC_URL") ?? "";
const CQ_KEY = Deno.env.get("CRYPTOQUANT_API_KEY") ?? "";
// Accept close variants of the secret's name (SOLTRACKER_API_KEY, SOLANA_TRACKER_KEY, ...)
const ST_KEY_NAME = Deno.env.get("SOLANATRACKER_API_KEY") ? "SOLANATRACKER_API_KEY"
  : Object.keys(Deno.env.toObject()).find((k) => /^SOL(ANA)?_?TRACKER(_?API)?_?KEY$/i.test(k)) ?? null;
const ST_KEY = (ST_KEY_NAME ? Deno.env.get(ST_KEY_NAME) : "")?.trim() ?? "";

const MAX_TRACKED = 60;        // wallets followed per run, manual ones first
const DISCOVER_COINS = 2;     // coins searched for big DEX traders each hour, round-robin over the watchlist
const POOL_TTL_MS = 7 * 86400e3;   // a coin's best pool rarely changes: search it again weekly
const NO_POOL_TTL_MS = 86400e3;    // "no verified pool" is rechecked daily
const MAX_TOP = 15;            // most profitable Solana traders followed (Solana Tracker leaderboard)
const TOP_EVERY_H = 6;         // leaderboard refresh interval: 4 calls/day of the free 10,000/month
const SOL_TX_BUDGET = 40;      // Solana getTransaction calls per run, across all wallets (RPC quota)
const SOL_TX_PER_WALLET = 5;
const MAX_AUTO = 40;           // auto-discovered wallets kept
const AUTO_PER_COIN = 10;      // so one very busy pool (e.g. WETH/USDC) can't take every slot
const AUTO_MIN_USD = 10000;    // DEX trade size that gets a wallet noticed
const MOVE_MIN_USD = 1000;     // smallest movement stored
const DEX_MIN_LIQ = 10000;
const EVM_CHAIN_ID: Record<string, number> = { eth: 1, sei: 1329 };
const NATIVE: Record<string, string> = { eth: "ETH", sei: "SEI", solana: "SOL" };
const EVM_LOOKBACK = { eth: 300, sei: 9000 };   // ~1h of blocks on first sight

// Verified token contracts; anything else is ignored. Discovery adds the coins it finds.
const BASE_TOKENS: Record<string, Record<string, string>> = {
  eth: {
    "0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "WETH",
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "WBTC",
  },
  sei: { "0xe30fedd158a2e3b13e9badaeabafc5516e95e8c7": "WSEI" },
  solana: {
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
    "So11111111111111111111111111111111111111112": "SOL",
  },
};
const ETH_EXCHANGES: Record<string, string> = {
  "0x28c6c06298d514db089934071355e5743bf21d60": "Binance", "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance",
  "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance", "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8": "Binance",
  "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "Coinbase", "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase",
  "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase", "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit",
  "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX", "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": "Kraken",
};
const CQ_METRICS = [
  "exchange-flows/netflow?exchange=all_exchange&window=day&limit=30",
  "exchange-flows/reserve?exchange=all_exchange&window=day&limit=30",
  "flow-indicator/exchange-whale-ratio?exchange=all_exchange&window=day&limit=30",
  "miner-flows/outflow?miner=all_miner&window=day&limit=30",
  "market-data/funding-rates?exchange=all_exchange&window=day&limit=30",
  "market-data/open-interest?exchange=all_exchange&window=day&limit=30",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Error text is stored where the website can read it: never let a key in a URL through
const SECRETS = [ETHERSCAN_KEY, SOLANA_RPC, CQ_KEY, ST_KEY].filter((s) => s.length > 6);
const errMsg = (e: unknown) => {
  let m = (e instanceof Error ? e.message : String(e)).replace(/(api[-_]?key=)[^&\s)"']+/gi, "$1***");
  for (const s of SECRETS) m = m.split(s).join("***");
  return m.slice(0, 200);
};

async function getJson(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text as unknown }; }
}
let lastGt = 0;
let gtDeadline = Infinity;   // discovery gets a fixed time budget each hour
let gtBlocked = false;      // set after a 429 that survived the retry: no more GeckoTerminal calls this run
async function gtJson(url: string) {
  for (let attempt = 0; ; attempt++) {
    if (gtBlocked) return { status: 429, body: null };   // already rate limited this hour: don't keep knocking
    const wait = lastGt + 3000 - Date.now();   // GeckoTerminal free tier: ~30 calls/min; the IP is shared, so slower
    if (wait > 0) await sleep(wait);
    lastGt = Date.now();
    const res = await getJson(url, { headers: { Accept: "application/json" } });
    // Rate limited (the server's IP is shared): wait once and retry, then give up for this hour
    if (res.status === 429 && attempt === 0 && Date.now() + 12000 < gtDeadline) { await sleep(12000); continue; }
    if (res.status === 429) gtBlocked = true;
    return res;
  }
}
async function loadState(keys: string[]): Promise<Record<string, any>> {
  const { data, error } = await db.from("collector_state").select("key,value").in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
}
async function saveState(entries: Record<string, unknown>) {
  const now = new Date().toISOString();
  const { error } = await db.from("collector_state").upsert(Object.entries(entries).map(([key, value]) => ({ key, value, updated_at: now })));
  if (error) throw error;
}

async function usdPrices(): Promise<Record<string, number>> {
  const { body } = await getJson("https://data-api.binance.vision/api/v3/ticker/price");
  const out: Record<string, number> = { USDT: 1, USDC: 1 };
  if (Array.isArray(body)) for (const p of body) if (p.symbol.endsWith("USDT")) out[p.symbol.slice(0, -4)] = +p.price;
  // Wrapped forms trade at the coin's price
  for (const [w, c] of [["WETH", "ETH"], ["WBTC", "BTC"], ["WSEI", "SEI"]]) if (out[c]) out[w] = out[c];
  return out;
}

// ---------------- Etherscan (Ethereum, Sei) ----------------
let lastEs = 0;
async function es(chainid: number, params: Record<string, string | number>) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastEs + 400 - Date.now();   // stay under the free tier's per-second limit (shared with 'collect')
    if (wait > 0) await sleep(wait);
    lastEs = Date.now();
    const qs = new URLSearchParams({ chainid: String(chainid), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), apikey: ETHERSCAN_KEY });
    const { body } = await getJson(`https://api.etherscan.io/v2/api?${qs}`);
    if (body?.error) throw new Error(body.error.message ?? "rpc error");
    if (body?.status === "0") {
      if (Array.isArray(body.result)) return [];                       // "No transactions found"
      if (/rate limit/i.test(String(body.result)) && !attempt) { await sleep(1200); continue; }
      throw new Error(String(body.result ?? body.message));
    }
    return body.result;
  }
  throw new Error("rate limited");
}

async function trackEvm(chain: string, w: any, cursors: Record<string, any>, latest: number, tokens: Record<string, string>, px: Record<string, number>) {
  const key = `${chain}:${w.address}`;
  const start = cursors[key] ?? latest - (EVM_LOOKBACK as any)[chain];
  const id = EVM_CHAIN_ID[chain], addr = w.address;
  const q = { module: "account", address: addr, startblock: start + 1, endblock: latest, sort: "asc", page: 1, offset: 100 };
  const [tok, nat] = [await es(id, { ...q, action: "tokentx" }), await es(id, { ...q, action: "txlist" })];
  const moves: any[] = [];
  let maxBlock = start, full = false;
  for (const t of tok) {
    maxBlock = Math.max(maxBlock, +t.blockNumber);
    const sym = tokens[String(t.contractAddress).toLowerCase()];
    if (!sym) continue;                                          // unverified token: likely spam
    const amount = Number(BigInt(t.value)) / 10 ** +t.tokenDecimal, inbound = t.to.toLowerCase() === addr;
    const cp = (inbound ? t.from : t.to).toLowerCase();
    moves.push({ id: `${chain}:${t.hash}:${t.contractAddress}:${t.from}:${t.to}:${t.value}`.toLowerCase(), chain, address: addr,
      time: new Date(+t.timeStamp * 1000).toISOString(), direction: inbound ? "in" : "out", token: sym, amount,
      usd: px[sym] ? amount * px[sym] : null, counterparty: cp, cp_label: ETH_EXCHANGES[cp] ?? null, tx_hash: t.hash });
  }
  for (const t of nat) {
    maxBlock = Math.max(maxBlock, +t.blockNumber);
    if (t.isError !== "0" || t.value === "0") continue;
    const amount = Number(BigInt(t.value)) / 1e18, inbound = String(t.to).toLowerCase() === addr, sym = NATIVE[chain];
    const cp = String(inbound ? t.from : t.to).toLowerCase();
    moves.push({ id: `${chain}:${t.hash}:native`, chain, address: addr, time: new Date(+t.timeStamp * 1000).toISOString(),
      direction: inbound ? "in" : "out", token: sym, amount, usd: px[sym] ? amount * px[sym] : null,
      counterparty: cp, cp_label: ETH_EXCHANGES[cp] ?? null, tx_hash: t.hash });
  }
  full = tok.length >= 100 || nat.length >= 100;
  // A full page means more remain: resume after the last block seen; otherwise we're caught up
  cursors[key] = full ? maxBlock : latest;
  return moves;
}

// ---------------- Solana (any RPC provider) ----------------
async function rpc(method: string, params: unknown[]) {
  const { body } = await getJson(SOLANA_RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (body?.error) throw new Error(`solana ${body.error.message ?? JSON.stringify(body.error).slice(0, 80)}`);
  return body?.result;
}

const solBudget = { left: SOL_TX_BUDGET };
const skippedTx: string[] = [];
async function trackSolana(w: any, cursors: Record<string, any>, tokens: Record<string, string>, px: Record<string, number>) {
  const key = `solana:${w.address}`, until = cursors[key];
  if (solBudget.left <= 0) return [];
  const sigs = (await rpc("getSignaturesForAddress", [w.address, until ? { until, limit: 25 } : { limit: 5 }])) ?? [];
  if (!sigs.length) return [];
  const moves: any[] = [];
  // Newest few only (busy traders make hundreds of transactions an hour): the cursor jumps to the
  // newest signature, so the feed stays current and the shared RPC budget isn't exceeded
  const take = Math.min(SOL_TX_PER_WALLET, solBudget.left);
  const batch = sigs.filter((s: any) => !s.err).slice(0, take).reverse();
  solBudget.left -= batch.length;
  for (const s of batch) {
    // Highest version accepted: legacy, v0 and v1 transactions; one unreadable tx doesn't stop the wallet
    let tx: any;
    try { tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]); }
    catch (e) { skippedTx.push(errMsg(e).slice(0, 80)); continue; }
    if (!tx?.meta) continue;
    const time = new Date((tx.blockTime ?? Date.now() / 1000) * 1000).toISOString();
    const add = (sym: string, delta: number, tag: string) => {
      if (Math.abs(delta) < 1e-9) return;
      const amount = Math.abs(delta), usd = px[sym] ? amount * px[sym] : null;
      moves.push({ id: `solana:${s.signature}:${tag}`, chain: "solana", address: w.address, time, direction: delta > 0 ? "in" : "out",
        token: sym, amount, usd, counterparty: null, cp_label: null, tx_hash: s.signature });
    };
    // Token balance changes of accounts owned by the wallet
    const bal = new Map<string, number>();
    for (const b of tx.meta.preTokenBalances ?? []) if (b.owner === w.address) bal.set(b.mint, (bal.get(b.mint) ?? 0) - (+b.uiTokenAmount.uiAmountString || 0));
    for (const b of tx.meta.postTokenBalances ?? []) if (b.owner === w.address) bal.set(b.mint, (bal.get(b.mint) ?? 0) + (+b.uiTokenAmount.uiAmountString || 0));
    for (const [mint, delta] of bal) { const sym = tokens[mint]; if (sym) add(sym, delta, mint); }
    // Native SOL: balance change of the wallet's own account, fee added back when it paid it
    const keys = tx.transaction.message.accountKeys.map((k: any) => k.pubkey ?? k);
    const i = keys.indexOf(w.address);
    if (i >= 0) {
      const fee = i === 0 ? tx.meta.fee : 0;
      add("SOL", (tx.meta.postBalances[i] - tx.meta.preBalances[i] + fee) / 1e9, "native");
    }
  }
  cursors[key] = sigs[0].signature;
  return moves;
}

// ---------------- discovery ----------------
// Same rule as the website: the coin itself, its wrapped form or a bridged version, per CoinGecko
function tokenMatches(tok: any, coin: string, cgId: string | null) {
  const id = tok?.coingecko_coin_id, sym = String(tok?.symbol ?? "").toUpperCase(), c = coin.toLowerCase();
  if (!id || !cgId || (sym !== coin && sym !== "W" + coin)) return false;
  return id === cgId || id === "w" + c || (id.includes("bridged") && id.includes(c)) || (id.startsWith("wrapped") && id.includes(cgId.split("-")[0]));
}

// pools: cache of the chosen pool per "COIN/dex" ({address, name, base} or {none: true}, with time)
async function discover(coins: string[], cg: Record<string, string | null>, tokens: Record<string, Record<string, string>>,
                        report: Record<string, string>, pools: Record<string, any>) {
  const found: any[] = [];
  // Sei DEX whales the collector already stores (the signer, when it was looked up)
  const since = new Date(Date.now() - 2 * 3600e3).toISOString();
  const { data: sei } = await db.from("whale_trades").select("wallet,usd,kind,time").eq("symbol", "SEI")
    .gte("time", since).gte("usd", AUTO_MIN_USD).not("wallet", "is", null);
  for (const t of sei ?? []) found.push({ chain: "sei", address: t.wallet, usd: t.usd, coin: "SEI", dex: "Sei DEX", side: t.kind });

  for (const coin of coins) {
    if (!(coin in cg)) {
      const { body } = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(coin)}`);
      const hit = (body?.coins ?? []).filter((c: any) => String(c.symbol).toUpperCase() === coin)
        .sort((a: any, b: any) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
      cg[coin] = hit?.id ?? null;
    }
    for (const [net, dexPrefix, chain] of [["eth", "uniswap", "eth"], ["solana", "raydium", "solana"]]) {
      const tag = `${coin}/${dexPrefix}`;
      if (Date.now() > gtDeadline || gtBlocked) { report[tag] = gtBlocked ? "GeckoTerminal giới hạn, lượt sau làm tiếp" : "hết thời gian, lượt sau làm tiếp"; continue; }
      let pool = pools[tag];
      const age = pool ? Date.now() - Date.parse(pool.at) : Infinity;
      if (!pool || age > (pool.none ? NO_POOL_TTL_MS : POOL_TTL_MS)) {
        const { status, body } = await gtJson(`https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(coin)}&network=${net}&include=base_token`);
        if (status !== 200) { report[tag] = `tìm pool lỗi ${status}`; continue; }
        const toks = new Map((body?.included ?? []).filter((i: any) => i.type === "token").map((i: any) => [i.id, i.attributes]));
        const best = (body?.data ?? []).filter((p: any) => {
          const a = p.attributes, base = toks.get(p.relationships.base_token.data.id);
          return p.relationships.dex.data.id.startsWith(dexPrefix) && tokenMatches(base, coin, cg[coin]) &&
            +a.reserve_in_usd >= DEX_MIN_LIQ && +(a.volume_usd?.h24 ?? 0) > 0;
        }).sort((x: any, y: any) => +y.attributes.volume_usd.h24 - +x.attributes.volume_usd.h24)[0];
        const base: any = best && toks.get(best.relationships.base_token.data.id);
        pool = pools[tag] = best
          ? { at: new Date().toISOString(), address: best.attributes.address, name: String(best.attributes.name).slice(0, 60),
              base: chain === "solana" ? base.address : String(base.address).toLowerCase() }
          : { at: new Date().toISOString(), none: true };
      }
      if (pool.none) { report[tag] = "không có pool đã xác minh"; continue; }
      // The coin's verified token on that chain becomes a valued token for tracking
      tokens[chain][pool.base] = coin;
      const { status: ts, body: tr } = await gtJson(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/${pool.address}/trades?trade_volume_in_usd_greater_than=${AUTO_MIN_USD}`);
      if (ts === 404) delete pools[tag];   // pool gone: search again next time
      report[tag] = ts !== 200 ? `${pool.name}: lấy lệnh lỗi ${ts}` : `${pool.name}: ${(tr?.data ?? []).length} lệnh ≥ $${AUTO_MIN_USD / 1000}K`;
      for (const x of tr?.data ?? []) {
        const a = x.attributes;
        const address = chain === "solana" ? a.tx_from_address : String(a.tx_from_address).toLowerCase();
        found.push({ chain, address, usd: +a.volume_in_usd, coin, dex: pool.name, side: a.kind });
      }
    }
  }
  // Biggest trade per wallet; skip exchange hot wallets
  const best = new Map<string, any>();
  for (const f of found) {
    if (!f.address || ETH_EXCHANGES[f.address]) continue;
    const k = `${f.chain}:${f.address}`;
    if (!best.has(k) || best.get(k).usd < f.usd) best.set(k, f);
  }
  return [...best.values()];
}

// ---------------- Solana Tracker: most profitable traders ----------------
// Realized PnL over 7 days, at least 30 trades on 4+ days, arbitrage bots excluded and no more than
// 40% of the profit from one token (filters one-lucky-memecoin wallets). Past results only.
async function topTraders() {
  const qs = new URLSearchParams({ days: "7", sort: "realized", direction: "desc", limit: String(MAX_TOP),
    minTrades: "30", minDays: "4", maxSingleTokenPct: "40", excludeArbitrage: "true", pnlMode: "strict" });
  const { status, body } = await getJson(`https://data.solanatracker.io/v2/pnl/leaderboard/top?${qs}`, { headers: { "x-api-key": ST_KEY } });
  if (status !== 200) throw new Error(`solanatracker ${status} ${String(body?.error ?? body?.message ?? "").slice(0, 80)}`);
  return (body?.traders ?? []).filter((t: any) => typeof t.wallet === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.wallet));
}

// ---------------- CryptoQuant ----------------
async function cryptoquant(assets: string[]) {
  const rows: any[] = [], summary: Record<string, string> = {};
  for (const asset of assets) {
    for (const m of CQ_METRICS) {
      const path = m.split("?")[0];
      if (path.startsWith("miner-flows") && asset !== "btc") continue;
      const { status, body } = await getJson(`https://api.cryptoquant.com/v1/${asset}/${m}`, { headers: { Authorization: `Bearer ${CQ_KEY}` } });
      await sleep(300);
      if (status !== 200) { summary[`${asset}/${path}`] = status === 401 || status === 403 ? "không có trong gói" : `lỗi ${status}`; continue; }
      const data = body?.result?.data ?? [];
      for (const r of data) {
        const t = r.date ?? r.datetime ?? r.timestamp;
        const time = typeof t === "number" ? new Date(t > 1e12 ? t : t * 1000) : new Date(String(t).length === 10 ? t + "T00:00:00Z" : t);
        if (isNaN(+time)) continue;
        for (const [k, v] of Object.entries(r)) {
          if (["date", "datetime", "timestamp"].includes(k) || typeof v !== "number" || !Number.isFinite(v)) continue;
          rows.push({ asset, metric: `${path}:${k}`, t: time.toISOString(), value: v });
        }
      }
      summary[`${asset}/${path}`] = data.length ? "ok" : "không có dữ liệu";
    }
  }
  if (rows.length) {
    const { error } = await db.from("cq_metrics").upsert(rows);
    if (error) throw error;
  }
  return summary;
}

// ---------------- main ----------------
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
  const errors: Record<string, string> = {};
  const notes: Record<string, unknown> = {};
  try {
    const st = await loadState(["smart_cursors", "smart_tokens", "smart_cg", "smart_lock", "smart_status", "smart_pools", "smart_disc"]);
    // One run at a time (the cron fires every 5 minutes; a run takes well under that)
    if (st.smart_lock?.at && Date.now() - Date.parse(st.smart_lock.at) < 240000) return Response.json({ ok: false, skipped: "busy" });
    // The URL is public: don't let repeated calls burn the free API quotas (cron runs every 5 minutes)
    if (st.smart_status?.at && Date.now() - Date.parse(st.smart_status.at) < 120000) return Response.json({ ok: false, skipped: "too soon" });
    await saveState({ smart_lock: { at: new Date().toISOString() } });
    const cursors: Record<string, any> = st.smart_cursors ?? {};
    const tokens: Record<string, Record<string, string>> = {
      eth: { ...BASE_TOKENS.eth, ...(st.smart_tokens?.eth ?? {}) }, sei: { ...BASE_TOKENS.sei, ...(st.smart_tokens?.sei ?? {}) },
      solana: { ...BASE_TOKENS.solana, ...(st.smart_tokens?.solana ?? {}) },
    };
    const cg: Record<string, string | null> = st.smart_cg ?? {};
    const px = await usdPrices();
    const { data: wl } = await db.from("watchlist").select("symbol,pinned").order("pinned", { ascending: false }).order("added_at");
    // Pinned coins first, then round-robin: a few coins per hour, every coin within a few hours
    const all = (wl ?? []).map((w) => w.symbol);
    const disc = st.smart_disc ?? { next: 0, by_coin: {} };
    const start = all.length ? disc.next % all.length : 0;
    const coins = [...all.slice(start), ...all.slice(0, start)].slice(0, DISCOVER_COINS);
    const pools: Record<string, any> = st.smart_pools ?? {};
    const hourly = new Date().getUTCMinutes() < 5;

    if (hourly) {
      try {
        const report: Record<string, string> = {};
        gtDeadline = Date.now() + 60000;
        const found = await discover(coins, cg, tokens, report, pools);
        // Move on only past coins that got their turn: a rate-limited coin goes first next hour
        const blocked = (c: string) => Object.entries(report).some(([k, v]) => k.startsWith(c + "/") && /giới hạn|hết thời gian|429/.test(v));
        const firstBlocked = coins.findIndex(blocked);
        disc.next = start + (firstBlocked === -1 ? coins.length : firstBlocked);
        // Latest result of every coin (each coin is only visited every few hours)
        const at = new Date().toISOString();
        for (const [k, v] of Object.entries(report)) disc.by_coin[k] = `${v} · ${at.slice(5, 16).replace("T", " ")} UTC`;
        for (const k of Object.keys(disc.by_coin)) if (!all.some((c) => k === c || k.startsWith(c + "/"))) delete disc.by_coin[k];
        notes.discover_by_coin = disc.by_coin;
        const { data: autosAll } = await db.from("smart_wallets").select("chain,address,meta,last_move,added_at").eq("source", "auto");
        const have = new Set((autosAll ?? []).map((a) => `${a.chain}:${a.address}`));
        // Per-coin cap: drop the least active wallets of a coin that has more than its share
        const autos = (autosAll ?? []).filter((a) => a.meta?.src !== "solanatracker");
        const byCoin = new Map<string, any[]>();
        for (const a of autos) { const c = a.meta?.coin ?? "?"; if (!byCoin.has(c)) byCoin.set(c, []); byCoin.get(c)!.push(a); }
        let pruned = 0;
        for (const list of byCoin.values()) {
          if (list.length <= AUTO_PER_COIN) continue;
          const extra = list.sort((x, y) => Date.parse(y.last_move ?? y.added_at) - Date.parse(x.last_move ?? x.added_at)).slice(AUTO_PER_COIN);
          for (const a of extra) {
            await db.from("smart_wallets").delete().eq("chain", a.chain).eq("address", a.address).eq("source", "auto");
            have.delete(`${a.chain}:${a.address}`);
          }
          list.length = AUTO_PER_COIN;
          pruned += extra.length;
        }
        const count = new Map([...byCoin].map(([c, l]) => [c, l.length]));
        let room = Math.max(0, MAX_AUTO - [...count.values()].reduce((x, y) => x + y, 0));
        const fresh: any[] = [];
        for (const f of found.filter((f) => !have.has(`${f.chain}:${f.address}`)).sort((a, b) => b.usd - a.usd)) {
          if (room <= 0) break;
          if ((count.get(f.coin) ?? 0) >= AUTO_PER_COIN) continue;
          fresh.push(f); count.set(f.coin, (count.get(f.coin) ?? 0) + 1); room--;
        }
        if (pruned) notes.pruned = pruned;
        if (fresh.length) {
          const day = new Date().toISOString().slice(0, 10);
          const { error } = await db.from("smart_wallets").upsert(fresh.map((f) => ({
            chain: f.chain, address: f.address, source: "auto",
            label: `${f.side === "sell" ? "Bán" : "Mua"} $${Math.round(f.usd / 1000)}K ${f.coin} (${f.dex}, ${day})`,
            meta: { coin: f.coin, dex: f.dex, usd: f.usd, side: f.side },
          })), { ignoreDuplicates: true });
          if (error) throw error;
        }
        notes.discovered = `${found.length} ví giao dịch lớn, thêm ${fresh.length}`;
      } catch (e) { errors.discover = errMsg(e); }
      if (CQ_KEY) {
        try { notes.cryptoquant = await cryptoquant(["btc", "eth"]); }
        catch (e) { errors.cryptoquant = errMsg(e); }
      }
    }

    // Solana Tracker leaderboard: every TOP_EVERY_H hours, or right away when none are followed yet
    let topNote = st.smart_status?.top ?? null;
    let topTry: string | null = st.smart_status?.top_try ?? null;
    if (ST_KEY) {
      const { data: tops } = await db.from("smart_wallets").select("address,source,meta").eq("chain", "solana");
      const current = (tops ?? []).filter((t) => t.meta?.src === "solanatracker");
      const due = hourly && new Date().getUTCHours() % TOP_EVERY_H === 0;
      // Empty list: try now, but at most once an hour so a bad key can't use up the monthly quota
      const retry = !current.length && (!topTry || Date.now() - Date.parse(topTry) > 3600e3);
      if (due || retry) {
        topTry = new Date().toISOString();
        try {
          const traders = await topTraders();
          const manual = new Set((tops ?? []).filter((t) => t.source === "manual").map((t) => t.address));
          const keepSet = new Set(traders.map((t: any) => t.wallet));
          const day = new Date().toISOString().slice(0, 10);
          const rows = traders.filter((t: any) => !manual.has(t.wallet)).map((t: any, i: number) => ({
            chain: "solana", address: t.wallet, source: "auto",
            label: `Top ${i + 1} lãi 7 ngày Solana (Solana Tracker, ${day})`,
            meta: { src: "solanatracker", rank: i + 1, day },
          }));
          if (rows.length) {
            const { error } = await db.from("smart_wallets").upsert(rows);   // refresh rank/label of ones already followed
            if (error) throw error;
          }
          // Wallets that dropped off the leaderboard are no longer followed
          const gone = current.filter((t) => !keepSet.has(t.address)).map((t) => t.address);
          if (gone.length) await db.from("smart_wallets").delete().eq("chain", "solana").eq("source", "auto").in("address", gone);
          topNote = { at: new Date().toISOString(), count: rows.length, removed: gone.length };
        } catch (e) { errors.solanatracker = errMsg(e); }
      }
    }

    // Follow wallets: manual first, then the most recently active auto ones
    const { data: wallets, error: wErr } = await db.from("smart_wallets").select("chain,address,source,last_move,added_at");
    if (wErr) throw wErr;
    const list = (wallets ?? []).filter((w) => w.chain !== "solana" || SOLANA_RPC).sort((a, b) =>
      (a.source === "manual" ? 0 : 1) - (b.source === "manual" ? 0 : 1) ||
      Date.parse(b.last_move ?? b.added_at) - Date.parse(a.last_move ?? a.added_at)).slice(0, MAX_TRACKED);
    const latest: Record<string, number> = {};
    if (ETHERSCAN_KEY) for (const chain of ["eth", "sei"]) if (list.some((w) => w.chain === chain)) {
      try { latest[chain] = parseInt(await es(EVM_CHAIN_ID[chain], { module: "proxy", action: "eth_blockNumber" }), 16); }
      catch (e) { errors[`block_${chain}`] = errMsg(e); }
    }
    const moves: any[] = [];
    for (const w of list) {
      try {
        if (w.chain === "solana") moves.push(...await trackSolana(w, cursors, tokens.solana, px));
        else if (latest[w.chain]) moves.push(...await trackEvm(w.chain, w, cursors, latest[w.chain], tokens[w.chain], px));
      } catch (e) { errors[`${w.chain}:${w.address.slice(0, 10)}`] = errMsg(e); }
      if (Date.now() - started > 110000) { notes.truncated = "hết thời gian, phần còn lại chạy lần sau"; break; }
    }
    const keep = moves.filter((m) => m.usd === null ? false : m.usd >= MOVE_MIN_USD);
    if (keep.length) {
      const { error } = await db.from("smart_moves").upsert(keep, { ignoreDuplicates: true });
      if (error) throw error;
      const lastBy = new Map<string, string>();
      for (const m of keep) { const k = `${m.chain}|${m.address}`; if (!lastBy.has(k) || lastBy.get(k)! < m.time) lastBy.set(k, m.time); }
      for (const [k, time] of lastBy) {
        const [chain, address] = k.split("|");
        await db.from("smart_wallets").update({ last_move: time }).eq("chain", chain).eq("address", address);
      }
    }
    await saveState({
      smart_cursors: cursors, smart_cg: cg, smart_pools: pools, smart_disc: disc,
      smart_tokens: { eth: tokens.eth, sei: tokens.sei, solana: tokens.solana },
      smart_lock: { at: null },
      smart_status: {
        at: new Date().toISOString(), ms: Date.now() - started, tracked: list.length, moves: keep.length, errors, notes,
        hourly: hourly ? { at: new Date().toISOString(), discovered: notes.discovered ?? null, by_coin: notes.discover_by_coin ?? null,
          cryptoquant: notes.cryptoquant ?? null,
          errors: Object.fromEntries(Object.entries(errors).filter(([k]) => k === "discover" || k === "cryptoquant")) }
          : (st.smart_status?.hourly ?? null),
        top: topNote, top_try: topTry, st_key_name: ST_KEY_NAME, solana_skipped: skippedTx.length ? skippedTx.slice(0, 3) : null,
        // Names only (never values), to help spot a misnamed secret
        st_key_candidates: ST_KEY_NAME ? null : Object.keys(Deno.env.toObject()).filter((k) => /TRACK/i.test(k)),
        keys: { etherscan: !!ETHERSCAN_KEY, solana: !!SOLANA_RPC, cryptoquant: !!CQ_KEY, solanatracker: !!ST_KEY },
      },
    });
    return Response.json({ ok: true, tracked: list.length, moves: keep.length, errors, notes });
  } catch (e) {
    const msg = errMsg(e);
    await saveState({ smart_lock: { at: null }, smart_status: { at: new Date().toISOString(), errors: { ...errors, fatal: msg }, notes,
      keys: { etherscan: !!ETHERSCAN_KEY, solana: !!SOLANA_RPC, cryptoquant: !!CQ_KEY, solanatracker: !!ST_KEY } } }).catch(() => {});
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
});

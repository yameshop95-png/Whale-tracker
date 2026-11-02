// Market data for the "Thị trường" page. pg_cron calls this every 15 minutes; each call does what is
// due:
//   every call      Binance Alpha token list (Binance's public Alpha API) and CoinGecko trending
//                   searches (public API): no CoinMarketCap credits.
//   hourly          CoinMarketCap: global metrics, Fear & Greed, Altcoin Season, CMC20/CMC100 and the
//                   top 200 by market cap (about 6 credits).
//   every 3 hours   CoinMarketCap categories Real World Assets Protocols and Tokenized ETFs.
//   daily           Fear & Greed history (fills fear_greed_daily).
//   weekly          coin metadata (logo, links, description, tags) for coins not refreshed in 30 days.
//   every 3 hours   SoSoValue spot ETF flows per asset (US: 10 assets, HK: 3); daily, per-fund history
//                   of the US BTC/ETH/SOL/XRP funds (resumes on the next call when time runs out).
// CoinMarketCap credits are counted from each response and capped (Basic plan: 15,000 a month): above
// SOFT_CAP only the hourly part runs, above HARD_CAP nothing from CoinMarketCap.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const CMC_KEY = (Deno.env.get("CMC_API_KEY") ?? "").trim();
const SOFT_CAP = 11_000, HARD_CAP = 13_500;   // credits a month
const CAT = { rwa: "6400b58c1701313dc2e853a9", tokenized_etf: "68639a79358e0763b448bf51" };
const HOUR = 3600e3;

const errMsg = (e: unknown) => {
  let m = e instanceof Error ? e.message : String(e);
  if (CMC_KEY.length > 8) m = m.split(CMC_KEY).join("***");
  return m.slice(0, 200);
};
const num = (x: unknown) => { if (x === null || x === undefined || x === "") return null; const v = Number(x); return Number.isFinite(v) ? v : null; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function loadState(keys: string[]) {
  const { data } = await db.from("collector_state").select("key,value").in("key", keys);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value])) as Record<string, any>;
}
const saveState = (key: string, value: unknown) =>
  db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });
const saveList = async (key: string, data: unknown) => {
  const { error } = await db.from("market_lists").upsert({ key, data, updated_at: new Date().toISOString() });
  if (error) throw new Error(`${key}: ${error.message}`);
};

// ---------------- CoinMarketCap (credits counted) ----------------
let usage = { month: "", credits: 0 };
async function cmc(path: string) {
  const r = await fetch("https://pro-api.coinmarketcap.com" + path, {
    headers: { "X-CMC_PRO_API_KEY": CMC_KEY, Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const b = await r.json().catch(() => null);
  usage.credits += Number(b?.status?.credit_count ?? 0) || 0;
  if (r.status !== 200 || !b?.data) throw new Error(`cmc ${path.split("?")[0]} ${r.status} ${String(b?.status?.error_message ?? "").slice(0, 100)}`);
  await sleep(1300);   // 50 requests a minute on Basic
  return b.data;
}
const coinRow = (c: any) => {
  const q = c.quote?.USD ?? {};
  return { id: c.id, symbol: c.symbol, name: c.name, slug: c.slug, rank: c.cmc_rank ?? null, price: num(q.price), mcap: num(q.market_cap),
    fdv: num(q.fully_diluted_market_cap), vol: num(q.volume_24h), chg1h: num(q.percent_change_1h), chg24h: num(q.percent_change_24h),
    chg7d: num(q.percent_change_7d), chg30d: num(q.percent_change_30d), circ: num(c.circulating_supply), total: num(c.total_supply),
    max: num(c.max_supply), platform: c.platform?.name ?? null };
};

async function hourly(result: Record<string, unknown>) {
  const g = await cmc("/v1/global-metrics/quotes/latest");
  const fg = await cmc("/v3/fear-and-greed/latest").catch((e) => { result.fear_greed_error = errMsg(e); return null; });
  const alt = await cmc("/v1/altcoin-season-index/latest").catch((e) => { result.altseason_error = errMsg(e); return null; });
  const c20 = await cmc("/v3/index/cmc20-latest").catch((e) => { result.cmc20_error = errMsg(e); return null; });
  const c100 = await cmc("/v3/index/cmc100-latest").catch((e) => { result.cmc100_error = errMsg(e); return null; });
  const q = g.quote?.USD ?? {};
  const row = {
    ts: new Date(Math.floor(Date.now() / HOUR) * HOUR).toISOString(),
    total_mcap: num(q.total_market_cap), total_vol: num(q.total_volume_24h), total_mcap_chg: num(q.total_market_cap_yesterday_percentage_change),
    btc_dom: num(g.btc_dominance), eth_dom: num(g.eth_dominance), stable_mcap: num(q.stablecoin_market_cap),
    defi_mcap: num(q.defi_market_cap), deriv_vol: num(q.derivatives_volume_24h),
    fear_greed: fg ? num(fg.value) : null, fg_class: fg?.value_classification ?? null,
    altseason: alt ? num(alt.altcoin_index) : null,
    cmc20: c20 ? num(c20.value) : null, cmc20_chg: c20 ? num(c20.value_24h_percentage_change) : null,
    cmc100: c100 ? num(c100.value) : null, cmc100_chg: c100 ? num(c100.value_24h_percentage_change) : null,
  };
  const { error } = await db.from("market_global").upsert(row);
  if (error) throw new Error(`market_global: ${error.message}`);
  if (c20?.constituents) await saveList("cmc20", (c20.constituents as any[]).map((x) => ({ id: x.id, symbol: x.symbol, name: x.name, weight: num(x.weight) })));
  const top = await cmc("/v1/cryptocurrency/listings/latest?limit=200&convert=USD");
  await saveList("top200", (top as any[]).map(coinRow));
  result.hourly = { fear_greed: row.fear_greed, altseason: row.altseason, top: (top as any[]).length };
}

async function categories(result: Record<string, unknown>) {
  for (const [key, id] of Object.entries(CAT)) {
    const d = await cmc(`/v1/cryptocurrency/category?id=${id}&limit=300`);
    await saveList(key, { name: d.name, num_tokens: d.num_tokens, mcap: num(d.market_cap), mcap_chg: num(d.market_cap_change),
      vol: num(d.volume), vol_chg: num(d.volume_change), avg_chg: num(d.avg_price_change), coins: (d.coins ?? []).map(coinRow) });
    result[key] = (d.coins ?? []).length;
  }
}

async function fearGreedHistory(result: Record<string, unknown>) {
  const d = await cmc("/v3/fear-and-greed/historical?limit=400");
  const rows = (d as any[]).map((x) => ({ day: new Date(Number(x.timestamp) * 1000).toISOString().slice(0, 10), value: num(x.value), class: x.value_classification ?? null }))
    .filter((x) => x.value !== null);
  for (let i = 0; i < rows.length; i += 500) await db.from("fear_greed_daily").upsert(rows.slice(i, i + 500));
  result.fear_greed_days = rows.length;
}

async function metadata(result: Record<string, unknown>) {
  // Coins on the page (top 200, RWA, tokenized ETFs) whose metadata is missing or older than 30 days
  const { data: lists } = await db.from("market_lists").select("key,data").in("key", ["top200", "rwa", "tokenized_etf"]);
  const ids = new Set<number>();
  for (const l of lists ?? []) for (const c of (Array.isArray(l.data) ? l.data : l.data?.coins ?? [])) if (c.id) ids.add(c.id);
  const { data: have } = await db.from("coin_meta").select("cmc_id,updated_at").gte("updated_at", new Date(Date.now() - 30 * 864e5).toISOString());
  const fresh = new Set((have ?? []).map((r) => r.cmc_id));
  const todo = [...ids].filter((i) => !fresh.has(i)).slice(0, 800);   // 1 credit per 100 coins
  for (let i = 0; i < todo.length; i += 100) {
    const d = await cmc(`/v2/cryptocurrency/info?id=${todo.slice(i, i + 100).join(",")}&aux=urls,logo,description,tags,platform,date_added`);
    const rows = Object.values(d as Record<string, any>).map((m) => ({
      cmc_id: m.id, symbol: m.symbol, name: m.name, slug: m.slug, logo: m.logo ?? null,
      description: String(m.description ?? "").slice(0, 1200) || null,
      website: m.urls?.website?.[0] ?? null, twitter: m.urls?.twitter?.[0] ?? null, explorer: m.urls?.explorer?.[0] ?? null,
      tags: (m.tags ?? []).slice(0, 12), category: m.category ?? null, platform: m.platform?.name ?? null,
      date_added: m.date_added ? String(m.date_added).slice(0, 10) : null, updated_at: new Date().toISOString() }));
    const { error } = await db.from("coin_meta").upsert(rows);
    if (error) throw new Error(`coin_meta: ${error.message}`);
  }
  result.metadata = todo.length;
}

// ---------------- SoSoValue: spot crypto ETF flows ----------------
// 100,000 requests a month, 20 a minute; only the most recent month is served, so each day is kept.
const SOSO_KEY = (Deno.env.get("SOSOVALUE_API_KEY") ?? "").trim();
const SOSO = "https://openapi.sosovalue.com/openapi/v1";
const ETF_SETS: [string, string][] = [
  ...["BTC", "ETH", "SOL", "XRP", "LTC", "HBAR", "DOGE", "LINK", "AVAX", "DOT"].map((a) => [a, "US"] as [string, string]),
  ["BTC", "HK"], ["ETH", "HK"], ["SOL", "HK"],
];
const ETF_TICKER_SETS: [string, string][] = [["BTC", "US"], ["ETH", "US"], ["SOL", "US"], ["XRP", "US"]];   // per-fund tables
let started = 0;
const BUDGET_MS = 115_000;
async function soso(path: string) {
  const r = await fetch(SOSO + path, { headers: { "x-soso-api-key": SOSO_KEY, Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const b = await r.json().catch(() => null);
  await sleep(3200);   // 20 requests a minute
  if (r.status !== 200 || String(b?.code) !== "0") {
    const m = String(b?.message ?? "").slice(0, 80);
    throw new Error(`sosovalue ${path.split("?")[0]} ${r.status} ${m}`.split(SOSO_KEY).join("***"));
  }
  return b.data;
}
async function etfFlows(result: Record<string, unknown>) {
  let rows = 0;
  const failed: string[] = [];
  for (const [asset, country] of ETF_SETS) {
    if (Date.now() - started > BUDGET_MS) { failed.push(`${asset}/${country}: next call`); continue; }
    try {
      const d = await soso(`/etfs/summary-history?symbol=${asset}&country_code=${country}&limit=40`);
      // The current trading day's flow settles T+1: rows without a flow are skipped until then
      const list = (Array.isArray(d) ? d : []).filter((x: any) => x?.date && num(x.total_net_inflow) !== null).map((x: any) => ({
        asset, country, day: String(x.date).slice(0, 10), net_inflow: num(x.total_net_inflow), value_traded: num(x.total_value_traded),
        net_assets: num(x.total_net_assets), cum_inflow: num(x.cum_net_inflow) }));
      if (list.length) { const { error } = await db.from("etf_flow_daily").upsert(list); if (error) throw new Error(error.message); }
      rows += list.length;
    } catch (e) { failed.push(`${asset}/${country}: ${errMsg(e)}`); }
  }
  result.etf_flows = { rows, failed };
  if (failed.some((f) => f.endsWith("next call"))) throw new Error("ETF flows: continuing next call");
}
async function etfTickers(result: Record<string, unknown>) {
  // Per-fund history for the main US products, once a day; resumes on the next call if time runs out
  const day = new Date().toISOString().slice(0, 10);
  const st = (await loadState(["etf_progress"])).etf_progress;
  const prog = st?.day === day ? st : { day, funds: null as null | { ticker: string; name: string; asset: string; country: string }[], done: [] as string[] };
  if (!prog.funds) {
    prog.funds = [];
    for (const [asset, country] of ETF_TICKER_SETS) {
      const d = await soso(`/etfs?symbol=${asset}&country_code=${country}`);
      for (const f of (Array.isArray(d) ? d : [])) if (f?.ticker) prog.funds.push({ ticker: String(f.ticker), name: String(f.name ?? ""), asset, country });
    }
  }
  let n = 0;
  for (const f of prog.funds) {
    if (prog.done.includes(f.ticker)) continue;
    if (Date.now() - started > BUDGET_MS) break;
    const d = await soso(`/etfs/${encodeURIComponent(f.ticker)}/history`);
    const list = (Array.isArray(d) ? d : []).filter((x: any) => x?.date && num(x.net_inflow) !== null).map((x: any) => ({
      ticker: f.ticker, day: String(x.date).slice(0, 10), asset: f.asset, country: f.country, name: f.name,
      net_inflow: num(x.net_inflow), cum_inflow: num(x.cum_inflow), net_assets: num(x.net_assets),
      share: num(x.currency_share), prem_dsc: num(x.prem_dsc), value_traded: num(x.value_traded) }));
    if (list.length) { const { error } = await db.from("etf_ticker_daily").upsert(list); if (error) throw new Error(error.message); }
    prog.done.push(f.ticker); n++;
  }
  await saveState("etf_progress", prog);
  result.etf_tickers = { funds: prog.funds.length, done: prog.done.length, this_call: n };
  if (prog.done.length < prog.funds.length) throw new Error("ETF funds: continuing next call");
}

// ---------------- free sources ----------------
async function binanceAlpha(result: Record<string, unknown>) {
  const r = await fetch("https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list",
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
  const b = await r.json().catch(() => null);
  if (r.status !== 200 || !Array.isArray(b?.data)) throw new Error(`binance alpha ${r.status} ${String(b?.message ?? "").slice(0, 80)}`);
  const list = (b.data as any[]).filter((t) => t.tokenId && t.symbol).map((t) => ({
    id: String(t.tokenId), symbol: String(t.symbol), name: String(t.name ?? ""), chain: t.chainName ?? null, contract: t.contractAddress ?? null,
    icon: t.iconUrl ?? null, price: num(t.price), chg24h: num(t.percentChange24h), vol: num(t.volume24h), mcap: num(t.marketCap),
    fdv: num(t.fdv), liq: num(t.liquidity), holders: num(t.holders), cex: t.listingCex === true || t.listingCex === "true", hot: t.hotTag === true || t.hotTag === "true" }));
  // First time a token shows up on Alpha
  const { data: seen } = await db.from("alpha_seen").select("token_id,first_seen");
  const known = new Map((seen ?? []).map((s) => [s.token_id, s.first_seen]));
  const fresh = list.filter((t) => !known.has(t.id)).map((t) => ({ token_id: t.id, symbol: t.symbol }));
  for (let i = 0; i < fresh.length; i += 500) await db.from("alpha_seen").upsert(fresh.slice(i, i + 500));
  const now = new Date().toISOString();
  await saveList("alpha", list.map((t) => ({ ...t, first_seen: known.get(t.id) ?? now })));
  result.alpha = { tokens: list.length, new: known.size ? fresh.length : 0 };
}

async function trending(result: Record<string, unknown>) {
  const r = await fetch("https://api.coingecko.com/api/v3/search/trending", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  const b = await r.json().catch(() => null);
  if (r.status !== 200 || !Array.isArray(b?.coins)) throw new Error(`coingecko trending ${r.status}`);
  await saveList("trending", {
    coins: (b.coins as any[]).map((c, i) => ({ pos: i + 1, id: c.item?.id, symbol: c.item?.symbol, name: c.item?.name, rank: c.item?.market_cap_rank ?? null,
      thumb: c.item?.thumb ?? null, price: num(c.item?.data?.price), chg24h: num(c.item?.data?.price_change_percentage_24h?.usd),
      mcap: c.item?.data?.market_cap ?? null, vol: c.item?.data?.total_volume ?? null })),
    categories: (b.categories ?? []).slice(0, 6).map((c: any) => ({ name: c.name, chg24h: num(c.data?.market_cap_change_percentage_24h?.usd) })),
  });
  result.trending = b.coins.length;
}

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}

Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  started = Date.now();
  const month = new Date().toISOString().slice(0, 7);
  const st = await loadState(["market_due", "cmc_usage"]);
  const due = st.market_due ?? {};
  usage = st.cmc_usage?.month === month ? st.cmc_usage : { month, credits: 0 };
  const result: Record<string, unknown> = {};
  const step = async (name: string, f: (r: Record<string, unknown>) => Promise<void>) => {
    try { await f(result); due[name] = new Date().toISOString(); }
    catch (e) { result[`${name}_error`] = errMsg(e); }
  };
  const older = (name: string, ms: number) => !due[name] || Date.now() - Date.parse(due[name]) > ms;
  await step("alpha", binanceAlpha);
  await step("trending", trending);
  if (CMC_KEY && usage.credits < HARD_CAP) {
    if (older("hourly", 55 * 60e3)) await step("hourly", hourly);
    if (usage.credits < SOFT_CAP) {
      if (older("categories", 3 * HOUR - 5 * 60e3)) await step("categories", categories);
      if (older("fgHistory", 24 * HOUR)) await step("fgHistory", fearGreedHistory);
      if (older("metadata", 7 * 24 * HOUR)) await step("metadata", metadata);
    }
  } else result.cmc = CMC_KEY ? `monthly credit cap reached (${usage.credits})` : "no CMC_API_KEY";
  if (SOSO_KEY) {
    if (older("etfFlows", 3 * HOUR - 5 * 60e3)) await step("etfFlows", etfFlows);
    if (older("etfTickers", 20 * HOUR) && Date.now() - started < BUDGET_MS - 20000) await step("etfTickers", etfTickers);
  }
  await db.from("market_global").delete().lt("ts", new Date(Date.now() - 400 * 864e5).toISOString());
  const status = { at: new Date().toISOString(), ms: Date.now() - started, credits_month: usage.credits, result };
  await saveState("market_due", due);
  await saveState("cmc_usage", usage);
  await saveState("market_status", status);
  return Response.json({ ok: true, ...status });
});

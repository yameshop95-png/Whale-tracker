// DeFi data from DefiLlama's free API (https://api-docs.defillama.com): TVL by chain and over time,
// stablecoin supply, the largest protocols with their 1d/7d TVL change, DEX volumes, fees, and the
// reserves of centralised exchanges (DefiLlama's CEX transparency entries). Stored once an hour in
// market_lists (public read) for the home page and Token Insight. Pro-only endpoints (unlocks, CEX
// inflows at constant prices, yields after 13/11/2026) are not used.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const DAY = 86400;

async function getJson(url: string, ms = 45000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { "Accept": "application/json" } });
  if (r.status !== 200) throw new Error(`${new URL(url).host}${new URL(url).pathname} ${r.status}`);
  return await r.json();
}
const save = async (key: string, data: unknown) => {
  const { error } = await db.from("market_lists").upsert({ key, data, updated_at: new Date().toISOString() });
  if (error) throw new Error(`${key}: ${error.message}`);
};
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// Value of a [ts, value] series n days before its last point (closest earlier point)
const ago = (s: [number, number][], days: number) => { if (!s.length) return null; const t = s[s.length - 1][0] - days * DAY; for (let i = s.length - 1; i >= 0; i--) if (s[i][0] <= t) return s[i][1]; return null; };
const pct = (now: number | null, then: number | null) => now !== null && then ? 100 * (now / then - 1) : null;

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now(), result: Record<string, unknown> = {}, errors: Record<string, string> = {};
  const overview: Record<string, unknown> = { at: new Date().toISOString() };
  const step = async (name: string, fn: () => Promise<void>) => { try { await fn(); } catch (e) { errors[name] = (e instanceof Error ? e.message : String(e)).slice(0, 160); } };

  await step("tvl_history", async () => {
    const h = await getJson("https://api.llama.fi/v2/historicalChainTvl");
    const s: [number, number][] = (h as any[]).map((x) => [+x.date, +x.tvl] as [number, number]).filter(([t, v]) => t > 0 && v > 0);
    const now = s[s.length - 1]?.[1] ?? null;
    Object.assign(overview, { tvl: now, tvl_1d: pct(now, ago(s, 1)), tvl_7d: pct(now, ago(s, 7)), tvl_30d: pct(now, ago(s, 30)) });
    await save("defi_tvl_hist", s.slice(-730));
    result.tvl_days = s.length;
  });
  await step("stablecoins", async () => {
    const h = await getJson("https://stablecoins.llama.fi/stablecoincharts/all");
    const s: [number, number][] = (h as any[]).map((x) => [+x.date, num(x.totalCirculatingUSD?.peggedUSD) ?? 0] as [number, number]).filter(([t, v]) => t > 0 && v > 0);
    const now = s[s.length - 1]?.[1] ?? null;
    Object.assign(overview, { stables: now, stables_1d: pct(now, ago(s, 1)), stables_7d: pct(now, ago(s, 7)), stables_30d: pct(now, ago(s, 30)) });
    await save("defi_stables_hist", s.slice(-730));
  });
  await step("chains", async () => {
    const c = await getJson("https://api.llama.fi/v2/chains");
    const list = (c as any[]).filter((x) => +x.tvl > 0).sort((a, b) => +b.tvl - +a.tvl).slice(0, 25)
      .map((x) => ({ name: String(x.name), symbol: x.tokenSymbol ? String(x.tokenSymbol) : null, tvl: +x.tvl }));
    await save("defi_chains", list);
  });
  await step("protocols", async () => {
    const p = await getJson("https://api.llama.fi/protocols", 60000);
    const pick = (x: any) => ({ name: String(x.name), slug: String(x.slug ?? ""), symbol: x.symbol && x.symbol !== "-" ? String(x.symbol).toUpperCase() : null,
      category: x.category ?? null, tvl: num(x.tvl), c1: num(x.change_1d), c7: num(x.change_7d), mcap: num(x.mcap), logo: typeof x.logo === "string" ? x.logo : null,
      chains: Array.isArray(x.chains) ? x.chains.slice(0, 6) : [], gecko_id: x.gecko_id ?? null, cmc: x.cmcId ?? null, url: typeof x.url === "string" ? x.url : null });
    const all = (p as any[]).filter((x) => num(x.tvl) && +x.tvl > 0);
    const cex = all.filter((x) => x.category === "CEX").sort((a, b) => +b.tvl - +a.tvl).slice(0, 40).map(pick);
    const defi = all.filter((x) => x.category !== "CEX").sort((a, b) => +b.tvl - +a.tvl).slice(0, 500).map(pick);
    await save("defi_protocols", defi);
    await save("defi_cex", cex);
    const cexNow = cex.reduce((s, x) => s + (x.tvl ?? 0), 0);
    // Weighted change of the exchanges' reserves (in USD, so it includes price moves)
    const before = (k: "c1" | "c7") => cex.reduce((s, x) => s + (x.tvl && x[k] !== null ? x.tvl / (1 + (x[k] as number) / 100) : x.tvl ?? 0), 0);
    Object.assign(overview, { cex: cexNow, cex_1d: pct(cexNow, before("c1")), cex_7d: pct(cexNow, before("c7")) });
    result.protocols = defi.length; result.cex = cex.length;
  });
  for (const [kind, key] of [["dexs", "defi_dexs"], ["fees", "defi_fees"]] as const) {
    await step(kind, async () => {
      const o = await getJson(`https://api.llama.fi/overview/${kind}?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true`, 60000);
      const list = ((o as any).protocols ?? []).filter((x: any) => num(x.total24h) && +x.total24h > 0).sort((a: any, b: any) => +b.total24h - +a.total24h)
        .slice(0, kind === "fees" ? 400 : 60)
        .map((x: any) => ({ name: String(x.displayName ?? x.name), slug: String(x.slug ?? ""), category: x.category ?? null, d24: num(x.total24h), d7: num(x.total7d),
          d30: num(x.total30d), c1: num(x.change_1d), c7: num(x.change_7d), logo: typeof x.logo === "string" ? x.logo : null, parent: x.parentProtocol ?? null }));
      await save(key, list);
      Object.assign(overview, kind === "dexs" ? { dex24h: num((o as any).total24h), dex_1d: num((o as any).change_1d), dex7d: num((o as any).total7d) }
        : { fees24h: num((o as any).total24h), fees_1d: num((o as any).change_1d), fees7d: num((o as any).total7d) });
    });
  }
  await step("overview", async () => { await save("defi_overview", overview); });
  await db.from("collector_state").upsert({ key: "defi_status", value: { at: new Date().toISOString(), ms: Date.now() - started, result, errors }, updated_at: new Date().toISOString() });
  return Response.json({ ok: !Object.keys(errors).length, ms: Date.now() - started, result, errors });
});

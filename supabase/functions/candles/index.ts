// Candle proxy for exchanges whose public API doesn't allow browser requests (KuCoin, LBank).
// Only fixed endpoints with validated parameters; responses are cacheable for a minute.
const KUCOIN_TYPES = new Set(["5min", "1hour", "6hour"]);
const LBANK_TYPES: Record<string, number> = { minute5: 300, hour1: 3600 };   // type -> seconds
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

function upstream(u: URL): string | null {
  const ex = u.searchParams.get("ex"), symbol = u.searchParams.get("symbol") ?? "", type = u.searchParams.get("type") ?? "";
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) return null;
  if (ex === "kucoin" && KUCOIN_TYPES.has(type)) {
    return `https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${symbol}-USDT`;
  }
  if (ex === "lbank" && LBANK_TYPES[type]) {
    const size = Math.min(2000, Math.max(1, parseInt(u.searchParams.get("size") ?? "200", 10) || 200));
    const start = Math.floor(Date.now() / 1000) - size * LBANK_TYPES[type];
    return `https://api.lbkex.com/v2/kline.do?symbol=${symbol.toLowerCase()}_usdt&size=${size}&type=${type}&time=${start}`;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = upstream(new URL(req.url));
  if (!url) return Response.json({ error: "bad request" }, { status: 400, headers: CORS });
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return new Response(await r.text(), {
      status: r.status,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
    });
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 200) }, { status: 502, headers: CORS });
  }
});

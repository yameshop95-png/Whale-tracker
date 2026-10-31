// Candle proxy for exchanges whose public API doesn't allow browser requests (KuCoin).
// Only a fixed endpoint with validated parameters; responses are cacheable for a minute.
const TYPES = new Set(["5min", "1hour", "6hour"]);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(req.url);
  const symbol = u.searchParams.get("symbol") ?? "", type = u.searchParams.get("type") ?? "";
  if (u.searchParams.get("ex") !== "kucoin" || !/^[A-Z0-9]{2,12}$/.test(symbol) || !TYPES.has(type)) {
    return Response.json({ error: "bad request" }, { status: 400, headers: CORS });
  }
  try {
    const r = await fetch(`https://api.kucoin.com/api/v1/market/candles?type=${type}&symbol=${symbol}-USDT`, {
      signal: AbortSignal.timeout(10000),
    });
    return new Response(await r.text(), {
      status: r.status,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
    });
  } catch (e) {
    return Response.json({ error: String(e).slice(0, 200) }, { status: 502, headers: CORS });
  }
});

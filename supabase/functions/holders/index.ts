// Holder bands: once a day (pg_cron), snapshot the largest holders of a few Solana tokens and
// record, per rank band, how much the band's wallets added or cut since the previous snapshot.
// Source: Solana Tracker Data API (holders sorted by amount; 1 request per token per day).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ed25519 } from "npm:@noble/curves@1.4.0/ed25519";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
// Same secret as the 'smart' function (close name variants accepted there too)
const ST_KEY_NAME = Deno.env.get("SOLANATRACKER_API_KEY") ? "SOLANATRACKER_API_KEY"
  : Object.keys(Deno.env.toObject()).find((k) => /^SOL(ANA)?_?TRACKER(_?API)?_?KEY$/i.test(k)) ?? null;
const ST_KEY = (ST_KEY_NAME ? Deno.env.get(ST_KEY_NAME) : "")?.trim() ?? "";

// Mints checked against CoinGecko (via GeckoTerminal) when added
const TOKENS: Record<string, string> = {
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  PENGU: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
  TRUMP: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
};
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000]];
const TOP_N = 1000;
// Accounts fetched (still one request, max 5000): staking programs keep each staker's tokens in a
// program-owned account (PYTH: ~half of its top 1,200), so extra rows keep 1,000 real wallets.
const FETCH_N = 2500;

const errMsg = (e: unknown) => {
  let m = e instanceof Error ? e.message : String(e);
  if (ST_KEY.length > 6) m = m.split(ST_KEY).join("***");
  return m.slice(0, 200);
};

// Program-derived addresses (pool vaults, AMM/CLMM authorities, program escrows) are not on the
// ed25519 curve: no one holds a private key for them, so they are infrastructure, not holders.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("bad base58"); n = n * 58n + BigInt(i); }
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
function isProgramOwned(addr: string) {
  try {
    const b = b58(addr);
    if (b.length !== 32) return true;
    ed25519.ExtendedPoint.fromHex(b);
    return false;
  } catch { return true; }
}

function gini(xs: number[]) {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
}

async function prices(): Promise<Record<string, number>> {
  const r = await fetch("https://data-api.binance.vision/api/v3/ticker/price", { signal: AbortSignal.timeout(15000) });
  const out: Record<string, number> = {};
  const body = await r.json().catch(() => []);
  if (Array.isArray(body)) for (const p of body) if (p.symbol.endsWith("USDT")) out[p.symbol.slice(0, -4)] = +p.price;
  return out;
}

async function snapshot(token: string, mint: string, day: string, price: number | null) {
  const r = await fetch(`https://data.solanatracker.io/tokens/${mint}/holders/paginated?limit=${FETCH_N}`,
    { headers: { "x-api-key": ST_KEY }, signal: AbortSignal.timeout(30000) });
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || !Array.isArray(body?.accounts)) throw new Error(`solanatracker ${r.status} ${String(body?.error ?? "").slice(0, 80)}`);

  // One wallet can own several token accounts: add them up; leave program-owned wallets out
  const byWallet = new Map<string, { bal: number; pct: number }>();
  let excluded = 0;
  for (const a of body.accounts) {
    if (typeof a.wallet !== "string" || !(+a.amount > 0)) continue;
    if (isProgramOwned(a.wallet)) { excluded++; continue; }
    const w = byWallet.get(a.wallet) ?? { bal: 0, pct: 0 };
    w.bal += +a.amount; w.pct += +a.percentage || 0;
    byWallet.set(a.wallet, w);
  }
  const ranked = [...byWallet].sort((a, b) => b[1].bal - a[1].bal).slice(0, TOP_N);
  if (ranked.length < 100) throw new Error(`only ${ranked.length} holders returned`);
  const cutoff = ranked[ranked.length - 1][1].bal;   // smallest balance still in the top list today
  const today = new Map(ranked.map(([w, x], i) => [w, { bal: x.bal, rank: i + 1 }]));

  // Previous snapshot (latest stored day before today)
  const { data: prevRows, error: pErr } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", token);
  if (pErr) throw pErr;
  const prev = (prevRows ?? []).filter((p) => p.day < day);
  const prevMap = new Map(prev.map((p) => [p.wallet, p]));

  const bands = BANDS.map(([band, lo, hi]) => {
    const now = ranked.slice(lo - 1, hi);
    const balance = now.reduce((s, [, x]) => s + x.bal, 0);
    const entered = prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null;
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      // Yesterday's wallets in this band: what are they holding today? A wallet that dropped out
      // of the top list holds at most today's cut-off balance, so that is used (a conservative cut).
      net = 0; left = 0;
      for (const p of prev) {
        if (p.rank < lo || p.rank > hi) continue;
        const t = today.get(p.wallet);
        if (!t) left++;
        net += (t ? t.bal : Math.min(cutoff, p.balance)) - p.balance;
      }
    }
    return { token, day, band, balance, net, left_top: left, entered };
  });

  const pctTop = (n: number) => ranked.slice(0, n).reduce((s, [, x]) => s + x.pct, 0);
  const daily = { token, day, price, holders: Number.isFinite(+body.total) ? +body.total : null,
    top10_pct: pctTop(10), top100_pct: pctTop(100), gini: gini(ranked.map(([, x]) => x.bal)), excluded };

  let { error } = await db.from("holder_bands").upsert(bands);
  if (error) throw error;
  ({ error } = await db.from("holder_daily").upsert(daily));
  if (error) throw error;
  // Keep only the newest snapshot per token (it is what tomorrow is compared with)
  ({ error } = await db.from("holder_snapshot").delete().eq("token", token));
  if (error) throw error;
  ({ error } = await db.from("holder_snapshot").insert(ranked.map(([wallet, x], i) => ({ token, wallet, balance: x.bal, rank: i + 1, day }))));
  if (error) throw error;
  return { holders: ranked.length, excluded, compared: prev.length > 0 };
}

Deno.serve(async () => {
  if (!ST_KEY) return Response.json({ ok: false, error: "no SOLANATRACKER_API_KEY" }, { status: 503 });
  const day = new Date().toISOString().slice(0, 10);
  // Once per UTC day per token: the URL is public, so repeated calls must not use API quota
  const { data: done, error } = await db.from("holder_daily").select("token").eq("day", day);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const doneSet = new Set((done ?? []).map((d) => d.token));
  const px = await prices().catch(() => ({} as Record<string, number>));
  const result: Record<string, unknown> = {};
  for (const [token, mint] of Object.entries(TOKENS)) {
    if (doneSet.has(token)) { result[token] = "already done today"; continue; }
    try { result[token] = await snapshot(token, mint, day, px[token] ?? null); }
    catch (e) { result[token] = { error: errMsg(e) }; }
    await new Promise((r) => setTimeout(r, 400));   // free tier: 3 requests/s
  }
  await db.from("collector_state").upsert({ key: "holders_status", value: { at: new Date().toISOString(), day, result }, updated_at: new Date().toISOString() });
  return Response.json({ ok: true, day, result });
});

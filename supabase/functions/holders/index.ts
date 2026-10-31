// Holder bands: once a day (pg_cron), snapshot the largest holders of a few tokens and record,
// per rank band, how much the band's wallets added or cut since the previous snapshot.
// - Solana tokens: Solana Tracker Data API (top 1,000 holders, 1 request per token per day)
// - Ethereum ERC-20: Ethplorer (top 100 holders, its free limit) + Infura (which of them are
//   contracts, and the exact balance of wallets that left the top list)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ed25519 } from "npm:@noble/curves@1.4.0/ed25519";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
// Same secret as the 'smart' function (close name variants accepted there too)
const ST_KEY_NAME = Deno.env.get("SOLANATRACKER_API_KEY") ? "SOLANATRACKER_API_KEY"
  : Object.keys(Deno.env.toObject()).find((k) => /^SOL(ANA)?_?TRACKER(_?API)?_?KEY$/i.test(k)) ?? null;
const ST_KEY = (ST_KEY_NAME ? Deno.env.get(ST_KEY_NAME) : "")?.trim() ?? "";
const INFURA_KEY = (Deno.env.get("INFURA_API_KEY") ?? "").trim();
// A personal (free) Ethplorer key is better; the public "freekey" works at low volume
const ETHPLORER_KEY = (Deno.env.get("ETHPLORER_API_KEY") ?? "").trim() || "freekey";

// Mints checked against CoinGecko (via GeckoTerminal) when added
const TOKENS: Record<string, string> = {
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  PENGU: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
  TRUMP: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
};
// ERC-20 on Ethereum mainnet (addresses checked against CoinGecko via GeckoTerminal)
const EVM_TOKENS: Record<string, { address: string; decimals: number }> = {
  ENA: { address: "0x57e114b691db790c35207b2e685d4a43181e6061", decimals: 18 },
  POL: { address: "0x455e53cbb86018ac2b8092fdcd39d8444affc3f6", decimals: 18 },
};
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000]];
const TOP_N = 1000;
// Accounts fetched (still one request, max 5000): staking programs keep each staker's tokens in a
// program-owned account (PYTH: ~half of its top 1,200), so extra rows keep 1,000 real wallets.
const FETCH_N = 2500;

const SECRETS = [ST_KEY, INFURA_KEY, ETHPLORER_KEY].filter((k) => k.length > 8);
const errMsg = (e: unknown) => {
  let m = e instanceof Error ? e.message : String(e);
  for (const k of SECRETS) m = m.split(k).join("***");
  return m.slice(0, 200);
};
type Ranked = [string, { bal: number; pct: number }][];
type Fetched = { ranked: Ranked; total: number | null; excluded: number; topN: number;
  exact?: (wallets: string[]) => Promise<Map<string, number>> };

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

async function fetchSolana(mint: string): Promise<Fetched> {
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
  return { ranked, total: Number.isFinite(+body.total) ? +body.total : null, excluded, topN: TOP_N };
}

// ---------------- Ethereum (Ethplorer + Infura) ----------------
async function infura(calls: { method: string; params: unknown[] }[]) {
  const out: any[] = [];
  for (let i = 0; i < calls.length; i += 50) {   // JSON-RPC batches of 50
    const batch = calls.slice(i, i + 50).map((c, j) => ({ jsonrpc: "2.0", id: i + j, ...c }));
    const r = await fetch(`https://mainnet.infura.io/v3/${INFURA_KEY}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch), signal: AbortSignal.timeout(20000) });
    const body = await r.json().catch(() => null);
    if (!Array.isArray(body)) throw new Error(`infura ${r.status} ${JSON.stringify(body).slice(0, 80)}`);
    for (const x of body) { if (x.error) throw new Error(`infura ${x.error.message ?? ""}`); out[x.id] = x.result; }
  }
  return out;
}
const balanceOfData = (wallet: string) => "0x70a08231" + wallet.slice(2).toLowerCase().padStart(64, "0");

async function fetchEvm(t: { address: string; decimals: number }): Promise<Fetched> {
  if (!INFURA_KEY) throw new Error("no INFURA_API_KEY");
  const r = await fetch(`https://api.ethplorer.io/getTopTokenHolders/${t.address}?apiKey=${ETHPLORER_KEY}&limit=100`, { signal: AbortSignal.timeout(20000) });
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || !Array.isArray(body?.holders)) throw new Error(`ethplorer ${r.status} ${JSON.stringify(body?.error ?? "").slice(0, 80)}`);
  const holders = body.holders.filter((h: any) => /^0x[0-9a-f]{40}$/i.test(h.address));
  // Contracts (DEX pools, staking, bridges, multisig safes) are left out, like Solana program accounts.
  // EIP-7702 delegated accounts (code 0xef0100...) are still key-held wallets.
  const codes = await infura(holders.map((h: any) => ({ method: "eth_getCode", params: [h.address, "latest"] })));
  const scale = 10n ** BigInt(t.decimals);
  const toNum = (raw: bigint) => Number(raw / scale) + Number(raw % scale) / Number(scale);
  let excluded = 0;
  const ranked: Ranked = [];
  holders.forEach((h: any, i: number) => {
    const code = String(codes[i] ?? "0x");
    if (code !== "0x" && !code.startsWith("0xef0100")) { excluded++; return; }
    let raw: bigint;
    try { raw = BigInt(h.rawBalance); } catch { return; }
    ranked.push([h.address.toLowerCase(), { bal: toNum(raw), pct: +h.share || 0 }]);
  });
  ranked.sort((a, b) => b[1].bal - a[1].bal);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} holders returned`);
  const exact = async (wallets: string[]) => {
    const res = await infura(wallets.map((w) => ({ method: "eth_call", params: [{ to: t.address, data: balanceOfData(w) }, "latest"] })));
    return new Map(wallets.map((w, i) => [w, toNum(BigInt(res[i] ?? "0x0"))]));
  };
  // Ethplorer has no holder count in this call; getTokenInfo would cost a second request
  return { ranked, total: null, excluded, topN: 100, exact };
}

async function snapshot(token: string, f: Fetched, day: string, price: number | null) {
  const { ranked, excluded } = f;
  const cutoff = ranked[ranked.length - 1][1].bal;   // smallest balance still in the top list today
  const today = new Map(ranked.map(([w, x], i) => [w, { bal: x.bal, rank: i + 1 }]));

  // Previous snapshot (latest stored day before today)
  const { data: prevRows, error: pErr } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", token);
  if (pErr) throw pErr;
  const prev = (prevRows ?? []).filter((p) => p.day < day);
  const prevMap = new Map(prev.map((p) => [p.wallet, p]));
  // Wallets that left the top list: their exact balance when the chain can be asked (Infura),
  // otherwise at most today's cut-off balance (a conservative estimate)
  const leftWallets = prev.filter((p) => !today.has(p.wallet)).map((p) => p.wallet);
  const exactLeft = f.exact && leftWallets.length ? await f.exact(leftWallets) : new Map<string, number>();

  const bands = BANDS.filter(([, lo]) => lo <= f.topN).map(([band, lo, hi]) => {
    const now = ranked.slice(lo - 1, hi);
    const balance = now.reduce((s, [, x]) => s + x.bal, 0);
    const entered = prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null;
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      // Yesterday's wallets in this band: what are they holding today?
      net = 0; left = 0;
      for (const p of prev) {
        if (p.rank < lo || p.rank > hi) continue;
        const t = today.get(p.wallet);
        if (!t) left++;
        const now = t ? t.bal : exactLeft.get(p.wallet) ?? Math.min(cutoff, p.balance);
        net += now - p.balance;
      }
    }
    return { token, day, band, balance, net, left_top: left, entered };
  });

  const pctTop = (n: number) => ranked.slice(0, n).reduce((s, [, x]) => s + x.pct, 0);
  const daily = { token, day, price, holders: f.total,
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
  if (!ST_KEY && !INFURA_KEY) return Response.json({ ok: false, error: "no SOLANATRACKER_API_KEY / INFURA_API_KEY" }, { status: 503 });
  const day = new Date().toISOString().slice(0, 10);
  // Once per UTC day per token: the URL is public, so repeated calls must not use API quota
  const { data: done, error } = await db.from("holder_daily").select("token").eq("day", day);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
  const doneSet = new Set((done ?? []).map((d) => d.token));
  const px = await prices().catch(() => ({} as Record<string, number>));
  const result: Record<string, unknown> = {};
  const jobs: [string, () => Promise<Fetched>][] = [
    ...Object.entries(TOKENS).map(([token, mint]) => [token, () => fetchSolana(mint)] as [string, () => Promise<Fetched>]),
    ...Object.entries(EVM_TOKENS).map(([token, t]) => [token, () => fetchEvm(t)] as [string, () => Promise<Fetched>]),
  ];
  for (const [token, fetcher] of jobs) {
    if (doneSet.has(token)) { result[token] = "already done today"; continue; }
    try { result[token] = await snapshot(token, await fetcher(), day, px[token] ?? null); }
    catch (e) { result[token] = { error: errMsg(e) }; }
    await new Promise((r) => setTimeout(r, 1100));   // Solana Tracker 3/s, Ethplorer freekey is slower
  }
  await db.from("collector_state").upsert({ key: "holders_status", value: { at: new Date().toISOString(), day, result }, updated_at: new Date().toISOString() });
  return Response.json({ ok: true, day, result });
});

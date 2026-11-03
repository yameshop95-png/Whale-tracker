// OKB holders on X Layer (where most OKB now lives) from OKX's OnchainOS data API:
// GET /api/v5/xlayer/address/native-token-position-list (top 10,000 native-token balances, 100 a page).
// Requests are signed as OKX asks: OK-ACCESS-SIGN = base64(HMAC-SHA256(secret, timestamp + method +
// requestPath + body)), with the key, passphrase and timestamp headers. Keys come from the secrets
// OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE and never leave this function.
// Once a day (after 01:00 UTC, retried until done) the top 1,000 are stored like the other coins
// (holder_bands / holder_daily / holder_snapshot, token "OKB"). No exchange labels yet (OKX's own
// wallets are among the largest). Price from OKX's public ticker (OKB is not on Binance).
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
const KEY = env("OKX_API_KEY"), SECRET = env("OKX_SECRET_KEY"), PASS = env("OKX_PASSPHRASE");
const HOST = "https://web3.okx.com";
const TOP = 1000, GAP_MS = 1200;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mask = (m: string) => { for (const s of [KEY, SECRET, PASS]) if (s.length > 4) m = m.split(s).join("***"); return m.slice(0, 200); };
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

async function sign(prehash: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(prehash)));
  let bin = ""; for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}
let lastCall = 0;
async function okx(path: string) {
  const wait = lastCall + GAP_MS - Date.now(); if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const ts = new Date().toISOString();
  const r = await fetch(HOST + path, { headers: { "OK-ACCESS-KEY": KEY, "OK-ACCESS-SIGN": await sign(ts + "GET" + path), "OK-ACCESS-PASSPHRASE": PASS, "OK-ACCESS-TIMESTAMP": ts },
    signal: AbortSignal.timeout(30000) });
  const body = await r.json().catch(() => null);
  if (r.status !== 200 || (body && body.code !== undefined && String(body.code) !== "0")) throw new Error(mask(`okx ${r.status} ${body?.code ?? ""} ${body?.msg ?? ""}`));
  return body;
}
// The docs show the list either inside data[0].positionList or as data itself; field names vary too
function rowsOf(body: any): { address: string; amount: number }[] {
  const d = body?.data, list = Array.isArray(d?.[0]?.positionList) ? d[0].positionList : Array.isArray(d) ? d : [];
  return list.map((x: any) => ({ address: String(x.holderAddress ?? x.address ?? "").toLowerCase(), amount: +(x.amount ?? x.holdingAmount ?? x.balance ?? 0) }))
    .filter((x: any) => /^0x[0-9a-f]{40}$/.test(x.address) && x.amount > 0);
}

// Contracts (bridge, pools, wrapped OKB…) left out, as for the other EVM coins: eth_getCode on X Layer's
// public node. If the node does not answer, the list is used as is and the run says so.
async function contracts(addrs: string[]) {
  // X Layer's public nodes refuse batches of more than a few calls ("too many RPC calls in batch
  // request"): 5 per batch, alternating between the two official endpoints
  const NODES = ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"];
  const out = new Set<string>(); let answered = 0, k = 0;
  for (let i = 0; i < addrs.length; i += 5) {
    const batch = addrs.slice(i, i + 5).map((a, j) => ({ jsonrpc: "2.0", id: i + j, method: "eth_getCode", params: [a, "latest"] }));
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(NODES[k++ % NODES.length], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch), signal: AbortSignal.timeout(15000) })
        .then((r) => r.json()).catch(() => null);
      if (!Array.isArray(res)) { await sleep(500); continue; }
      for (const x of res) if (typeof x?.result === "string") { answered++; if (x.result !== "0x" && !x.result.startsWith("0xef0100")) out.add(addrs[x.id]); }
      break;
    }
    await sleep(60);
  }
  return { out, answered };
}

type Prev = { wallet: string; balance: number; rank: number }[];
type Ranked = [string, number][];
function gini(xs: number[]) {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
}
// Yesterday's members of a band, their balance today minus yesterday; a wallet that left the list
// counts at most at today's cut-off balance (conservative estimate)
function bandRows(day: string, ranked: Ranked, prev: Prev) {
  const cutoff = ranked[ranked.length - 1][1], now = new Map(ranked), prevMap = new Map(prev.map((p) => [p.wallet, p]));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const cur = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) { net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; const t = now.get(p.wallet); if (t === undefined) left++; net += (t ?? Math.min(cutoff, p.balance)) - p.balance; } }
    return { token: "OKB", day, band, balance: cur.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? cur.filter(([w]) => !prevMap.has(w)).length : null };
  });
}

async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}
Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now(), day = new Date().toISOString().slice(0, 10);
  const result: Record<string, unknown> = {};
  try {
    if (!KEY || !SECRET || !PASS) throw new Error(`missing secrets: ${[!KEY && "OKX_API_KEY", !SECRET && "OKX_SECRET_KEY", !PASS && "OKX_PASSPHRASE"].filter(Boolean).join(", ")}`);
    const { data: done } = await db.from("holder_daily").select("day").eq("token", "OKB").eq("day", day);
    if (done?.length) { result.snapshot = "done today"; return Response.json({ ok: true, result }); }
    const all: { address: string; amount: number }[] = [];
    for (let page = 1; page <= TOP / 100; page++) {
      const body = await okx(`/api/v5/xlayer/address/native-token-position-list?chainShortName=XLAYER&page=${page}&limit=100`);
      if (page === 1) result.sample = JSON.stringify(body?.data?.[0] ? { ...body.data[0], positionList: (body.data[0].positionList ?? []).slice(0, 1) } : body?.data?.slice?.(0, 1) ?? null).slice(0, 300);
      const rows = rowsOf(body);
      all.push(...rows);
      if (rows.length < 100) break;
    }
    const best = new Map<string, number>();
    for (const r of all) best.set(r.address, Math.max(best.get(r.address) ?? 0, r.amount));
    const cands = [...best].sort((a, b) => b[1] - a[1]);
    const { out: isC, answered } = await contracts(cands.map(([a]) => a));
    result.contract_check = { checked: cands.length, answered, contracts: isC.size };
    if (answered < cands.length * 0.9) result.contract_check_note = "X Layer nodes answered too few addresses: contracts may remain in the list today";
    const ranked: Ranked = cands.filter(([a]) => !isC.has(a)).slice(0, TOP);
    if (ranked.length < 10) throw new Error(`only ${ranked.length} holders returned`);
    const { data: prevRows, error: pe } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", "OKB");
    if (pe) throw pe;
    const prev = (prevRows ?? []).filter((p) => p.day < day);
    const bands = bandRows(day, ranked, prev);
    const px = await fetch("https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT", { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
    const price = +(px?.data?.[0]?.last ?? 0) || null;
    let { error } = await db.from("holder_bands").upsert(bands);
    if (error) throw error;
    ({ error } = await db.from("holder_daily").upsert({ token: "OKB", day, price, holders: null, top10_pct: null, top100_pct: null,
      gini: gini(ranked.map(([, b]) => b)), excluded: isC.size, source: "okx onchainos (x layer)", depth: ranked.length }));
    if (error) throw error;
    ({ error } = await db.from("holder_snapshot").delete().eq("token", "OKB"));
    if (error) throw error;
    for (let i = 0; i < ranked.length; i += 500) {
      ({ error } = await db.from("holder_snapshot").insert(ranked.slice(i, i + 500).map(([wallet, balance], j) => ({ token: "OKB", wallet, balance, rank: i + j + 1, day, exchange: null }))));
      if (error) throw error;
    }
    result.snapshot = { top: ranked.length, compared: prev.length > 0, top1: Math.round(ranked[0][1]), price, net_1_100: bands.find((b) => b.band === "1-100")?.net ?? null };
  } catch (e) {
    result.error = mask(e instanceof Error ? e.message : String(e));
  } finally {
    await saveState("okb_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
  }
  return Response.json({ ok: !result.error, result });
});

// Holder bands: every day, snapshot the largest holders of a set of coins and record, per rank band,
// how much the band's wallets added or cut since the previous snapshot.
//
// Sources (one daily call per coin unless noted):
// - Solana SPL (PYTH, PENGU, TRUMP, RAY, BOME): Solana Tracker, top 1,000 accounts.
// - The owner's chosen ERC-20 / BEP-20 (ENA, POL on Ethereum; OP on Optimism; ASTER, XVS on BSC):
//   GoldRush top 1,000 holders (GOLDRUSH_API_KEY) and 90-day history; if GoldRush refuses a token or
//   has no key: Ethplorer / Binplorer / Blockscout top 100.
// - The other tokens among the radar's top 120 coins (Ethereum, BSC, Solana): free sources, see
//   buildUniverse().
// - Native coins: ETH (Bitquery realtime list, BITQUERY_API_KEY), SEI (Seistream), APT (Aptos Labs
//   indexer), ALGO (Algorand indexer via Nodely), DOT (Subscan via the PubFi gateway, SUBSCAN_API_KEY;
//   exact balances via OnFinality, ONFINALITY_API_KEY).
//
// Contracts are left out on EVM chains (pools, staking, bridges, safes): each address is checked on two
// nodes (publicnode + Infura, OnFinality where Infura fails) once and the answer is cached; an address
// without two answers is not used.
//
// pg_cron calls this every 5 minutes from 00:07 to 04:57 UTC. Each call has a time budget and only
// does coins not yet done that day, so a slow day finishes on a later call. With time left, it rebuilds
// up to 90 days of history for the GoldRush tokens (holders at a past block), a few days per call.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ed25519 } from "npm:@noble/curves@1.4.0/ed25519";
import { blake2b } from "npm:@noble/hashes@1.4.0/blake2b";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const env = (k: string) => (Deno.env.get(k) ?? "").trim();
// Same secret as the 'smart' function (close name variants accepted there too)
const ST_KEY_NAME = Deno.env.get("SOLANATRACKER_API_KEY") ? "SOLANATRACKER_API_KEY"
  : Object.keys(Deno.env.toObject()).find((k) => /^SOL(ANA)?_?TRACKER(_?API)?_?KEY$/i.test(k)) ?? null;
const ST_KEY = (ST_KEY_NAME ? Deno.env.get(ST_KEY_NAME) : "")?.trim() ?? "";
const INFURA_KEY = env("INFURA_API_KEY");
const ETHPLORER_KEY = env("ETHPLORER_API_KEY") || "freekey";   // public key works at low volume
const BITQUERY_KEY = env("BITQUERY_API_KEY");
const GOLDRUSH_KEY = env("GOLDRUSH_API_KEY");
const SUBSCAN_KEY = env("SUBSCAN_API_KEY");   // a PubFi key (pf_...): Subscan's free access goes through the PubFi gateway
const ONFINALITY_KEY = env("ONFINALITY_API_KEY");

const RUN_BUDGET_MS = 105_000;        // stop starting new work after this (the platform limit is 150 s)
const GR_DAILY_CREDITS = 400;         // hard stop for GoldRush spending per UTC day
const GR_MONTHLY_CREDITS = 9000;      // and per month (the plan includes 10,000)
const HISTORY_DAYS = 90;
const TOP_N = 1000;

const SOL_TOKENS: Record<string, string> = {   // mints checked against CoinGecko when added
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  PENGU: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv",
  TRUMP: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82",
};
type Chain = "eth" | "op" | "bsc";
const CHAINS: Record<Chain, { gr: string; infura: string; of: string; pub: string }> = {
  eth: { gr: "eth-mainnet", infura: "mainnet", of: "eth", pub: "https://ethereum-rpc.publicnode.com" },
  op: { gr: "optimism-mainnet", infura: "optimism-mainnet", of: "optimism", pub: "https://optimism-rpc.publicnode.com" },
  bsc: { gr: "bsc-mainnet", infura: "bsc-mainnet", of: "bnb", pub: "https://bsc-rpc.publicnode.com" },
};
// The owner's chosen tokens: top 1,000 every day from GoldRush (paid credits) + 90-day history.
// Contract addresses checked against CoinGecko's platform list when added.
const ERC20: Record<string, { chain: Chain; address: string; decimals: number }> = {
  ENA: { chain: "eth", address: "0x57e114b691db790c35207b2e685d4a43181e6061", decimals: 18 },
  POL: { chain: "eth", address: "0x455e53cbb86018ac2b8092fdcd39d8444affc3f6", decimals: 18 },
  OP: { chain: "op", address: "0x4200000000000000000000000000000000000042", decimals: 18 },
  ASTER: { chain: "bsc", address: "0x000ae314e2a2172a039b26378814c252734f556a", decimals: 18 },
  XVS: { chain: "bsc", address: "0xcf6bb5389c92bdda8a3747ddb454cb7a64626c63", decimals: 18 },
};
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000]];
const FETCH_N = 2500;   // Solana accounts fetched: staking programs hold many top accounts

const SECRETS = [ST_KEY, INFURA_KEY, ETHPLORER_KEY, BITQUERY_KEY, GOLDRUSH_KEY, SUBSCAN_KEY, ONFINALITY_KEY].filter((k) => k.length > 8);
const errMsg = (e: unknown) => {
  let m = e instanceof Error ? e.message : String(e);
  for (const k of SECRETS) m = m.split(k).join("***");
  return m.slice(0, 220);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Ranked = [string, { bal: number; pct: number }][];
type Fetched = { ranked: Ranked; total: number | null; excluded: number; topN: number;
  exact?: (wallets: string[]) => Promise<Map<string, number>>; notes?: Record<string, unknown>;
  labelChain?: Chain };   // EVM tokens: chain whose exchange labels apply
class Later extends Error {}   // not finished within this call's budget: the next call continues

let deadline = Infinity;
const timeLeft = () => deadline - Date.now();

async function getJson(url: string, init: RequestInit = {}, ms = 30000) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function loadState(keys: string[]) {
  const { data } = await db.from("collector_state").select("key,value").in("key", keys);
  return Object.fromEntries((data ?? []).map((r) => [r.key, r.value])) as Record<string, any>;
}
const saveState = (key: string, value: unknown) =>
  db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

// ---------------- Solana ----------------
// Program-derived addresses (pool vaults, AMM authorities, escrows) are not on the ed25519 curve
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
  try { const b = b58(addr); if (b.length !== 32) return true; ed25519.ExtendedPoint.fromHex(b); return false; }
  catch { return true; }
}
async function fetchSolana(mint: string): Promise<Fetched> {
  if (!ST_KEY) throw new Error("no SOLANATRACKER_API_KEY");
  const { status, body } = await getJson(`https://data.solanatracker.io/tokens/${mint}/holders/paginated?limit=${FETCH_N}`, { headers: { "x-api-key": ST_KEY } });
  if (status !== 200 || !Array.isArray(body?.accounts)) throw new Error(`solanatracker ${status} ${String(body?.error ?? "").slice(0, 80)}`);
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

// ---------------- EVM: RPC and the contract check ----------------
const rpcErrors: Record<string, string> = {};
// Second source for the contract check: Infura, and OnFinality where Infura does not answer an address
const secondUrls = (c: Chain) => [
  ...(INFURA_KEY ? [`https://${CHAINS[c].infura}.infura.io/v3/${INFURA_KEY}`] : []),
  ...(ONFINALITY_KEY ? [`https://${CHAINS[c].of}.api.onfinality.io/rpc?apikey=${ONFINALITY_KEY}`] : []),
];
// publicnode answers large JSON-RPC batches reliably
async function rpcBig(url: string, calls: { method: string; params: unknown[] }[]) {
  const out: (string | undefined)[] = Array.from({ length: calls.length }, () => undefined);
  for (let i = 0; i < calls.length; i += 100) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ids = []; for (let k = i; k < Math.min(i + 100, calls.length); k++) if (out[k] === undefined) ids.push(k);
      if (!ids.length) break;
      try {
        const { status, body } = await getJson(url, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ids.map((id) => ({ jsonrpc: "2.0", id, ...calls[id] }))) }, 25000);
        if (!Array.isArray(body)) { rpcErrors[new URL(url).host] ??= errMsg(`${status} ${JSON.stringify(body).slice(0, 80)}`); continue; }
        for (const x of body) { const id = Number(x?.id); if (Number.isInteger(id) && typeof x?.result === "string") out[id] = x.result; }
      } catch (e) { rpcErrors[new URL(url).host] ??= errMsg(e); }
    }
  }
  return out;
}
// Infura answers only part of a batch, silently, and OnFinality limits batches: single requests,
// 4 at a time, each tried on the next URL when the first does not answer; missing ones retried
async function rpcSingles(urls: string[], calls: { method: string; params: unknown[] }[]) {
  const out: (string | undefined)[] = Array.from({ length: calls.length }, () => undefined);
  const one = async (id: number) => {
    for (const url of urls) {
      const host = new URL(url).host;
      try {
        const { status, body: x } = await getJson(url, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, ...calls[id] }) }, 15000);
        if (x && !x.error && typeof x.result === "string") { out[id] = x.result; return; }
        rpcErrors[host] ??= errMsg(`${status} ${JSON.stringify(x?.error ?? x).slice(0, 100)}`);
      } catch (e) { rpcErrors[host] ??= errMsg(e); }
    }
  };
  let todo = calls.map((_, i) => i);
  for (let round = 0; round < 3 && todo.length; round++) {
    if (round) await sleep(1500 * round);
    for (let k = 0; k < todo.length; k += 4) {
      if (timeLeft() < 8000) return out;   // the caller sees the gaps and continues next call
      if (k) await sleep(120 * (round + 1));
      await Promise.all(todo.slice(k, k + 4).map(one));
    }
    todo = todo.filter((id) => out[id] === undefined);
  }
  return out;
}
const isContractCode = (c: string) => c !== "0x" && !c.startsWith("0xef0100");   // EIP-7702 accounts are wallets

// Cache of the contract check: "chain:address" -> "c" contract / "w" wallet (both nodes agreed)
let codeCache: Record<string, string> = {};
let codeCacheDirty = false;
async function contractsIn(chain: Chain, addrs: string[]) {
  const todo = [...new Set(addrs)].filter((a) => !codeCache[`${chain}:${a}`]);   // ("#tries" keys are counters only)
  const stats = { checked: todo.length, mismatch: 0, single_source: false };
  if (todo.length) {
    const calls = todo.map((a) => ({ method: "eth_getCode", params: [a, "latest"] }));
    const [pub, inf] = await Promise.all([rpcBig(CHAINS[chain].pub, calls), secondUrls(chain).length ? rpcSingles(secondUrls(chain), calls) : Promise.resolve(calls.map(() => undefined))]);
    // One node completely silent (outage, chain not enabled on the Infura key): the other alone
    const pubDown = pub.every((x) => x === undefined), infDown = inf.every((x) => x === undefined);
    if (pubDown && infDown) throw new Error(`no node answered eth_getCode on ${chain} ${JSON.stringify(rpcErrors)}`);
    stats.single_source = pubDown || infDown;
    todo.forEach((a, i) => {
      // Infura keeps failing some addresses (BSC: "Internal error"): after 2 calls, publicnode alone
      const tries = `${chain}:${a}#tries`;
      if (!infDown && inf[i] === undefined && pub[i] !== undefined) {
        codeCache[tries] = String(+(codeCache[tries] ?? 0) + 1); codeCacheDirty = true;
        if (+codeCache[tries] >= 2) { codeCache[`${chain}:${a}`] = isContractCode(pub[i]!) ? "c" : "w"; stats.single_source = true; return; }
      }
      const answers = [pubDown ? null : pub[i], infDown ? null : inf[i]].filter((x) => x !== null);
      if (answers.some((x) => x === undefined)) return;   // not answered yet: unknown, decided on a later call
      const c = answers.map((x) => isContractCode(x!));
      if (c.length === 2 && c[0] !== c[1]) { stats.mismatch++; codeCache[`${chain}:${a}`] = "c"; }   // disagreement: treat as contract
      else codeCache[`${chain}:${a}`] = c[0] ? "c" : "w";
      codeCacheDirty = true;
    });
  }
  const unknown = addrs.filter((a) => !codeCache[`${chain}:${a}`]);
  if (unknown.length) throw new Later(`${unknown.length} addresses on ${chain} still to check`);
  return { isContract: (a: string) => codeCache[`${chain}:${a}`] === "c", stats };
}
const balanceOfData = (w: string) => "0x70a08231" + w.slice(2).toLowerCase().padStart(64, "0");
const toUnits = (raw: bigint, decimals: number) => { const s = 10n ** BigInt(decimals); return Number(raw / s) + Number(raw % s) / Number(s); };

// Shared ranking for EVM lists: drop contracts, keep the largest wallets
async function rankEvm(chain: Chain, list: { address: string; raw: bigint; pct?: number }[], decimals: number, topN: number, extra: Record<string, unknown>,
                       balanceCall: (w: string) => { method: string; params: unknown[] }): Promise<Fetched> {
  const { isContract, stats } = await contractsIn(chain, list.map((x) => x.address));
  const contracts = list.filter((x) => isContract(x.address)).map((x) => x.address);
  const ranked: Ranked = list.filter((x) => !isContract(x.address) && x.raw > 0n)
    .map((x) => [x.address, { bal: toUnits(x.raw, decimals), pct: x.pct ?? 0 }] as [string, { bal: number; pct: number }])
    .sort((a, b) => b[1].bal - a[1].bal).slice(0, topN);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} wallets after removing contracts`);
  const exact = async (wallets: string[]) => {
    const res = await rpcBig(CHAINS[chain].pub, wallets.map(balanceCall));
    const m = new Map<string, number>();
    wallets.forEach((w, i) => { if (res[i] !== undefined) { try { m.set(w, toUnits(BigInt(res[i]!), decimals)); } catch { /* skip */ } } });
    return m;   // a wallet without an answer falls back to the cut-off estimate
  };
  return { ranked, total: (extra.total as number) ?? null, excluded: contracts.length, topN, exact, labelChain: chain,
    notes: { ...extra, total: undefined, contract_check: stats, contracts: contracts.slice(0, 20), rpc_errors: { ...rpcErrors } } };
}

// ---------------- exchange labels ----------------
// An exchange wallet holds its customers' coins: its moves are deposits and withdrawals, not one
// whale's decision. Labels come from Blockscout's public address tags (Open Labels Initiative). BNB
// Chain has no Blockscout, so its addresses use their Ethereum label (exchanges reuse the same
// addresses across EVM chains). Kept in wallet_labels and re-checked after 30 days.
const LABEL_TTL_MS = 30 * 864e5;
const LABEL_TOP = 100;   // labels are looked up for each token's 100 largest wallets
const labelKey = (chain: Chain, a: string) => `${chain === "op" ? "op" : "eth"}:${a.toLowerCase()}`;
const LABEL_HOST: Record<string, string> = { eth: "eth.blockscout.com", op: "optimism.blockscout.com" };
function exchangeFromTags(address: any): string | null {
  const tags: any[] = address?.metadata?.tags ?? [];
  if (!tags.some((t) => t?.slug === "exchange")) return null;
  const n = tags.find((t) => t?.meta?.main_entity)?.meta?.main_entity ?? tags.find((t) => t?.tagType === "protocol")?.name
    ?? tags.find((t) => t?.tagType === "name")?.name ?? "Exchange";
  return String(n).split(/[:\d(]/)[0].trim().slice(0, 40) || "Exchange";
}
let labels = new Map<string, { exchange: string | null; at: number }>();   // known labels of this call
const labelRows = new Map<string, { key: string; exchange: string | null; checked_at: string }>();   // to save
function noteLabel(key: string, exchange: string | null) {
  labels.set(key, { exchange, at: Date.now() });
  labelRows.set(key, { key, exchange, checked_at: new Date().toISOString() });
}
async function loadLabels(keys: string[]) {
  const want = keys.filter((k) => !labels.has(k));
  for (let i = 0; i < want.length; i += 1000) {
    const { data } = await db.rpc("labels_for", { keys: want.slice(i, i + 1000) });
    for (const r of data ?? []) labels.set(r.key, { exchange: r.exchange, at: Date.parse(r.checked_at) });
  }
}
async function saveLabels() {
  const rows = [...labelRows.values()];
  for (let i = 0; i < rows.length; i += 500) await db.from("wallet_labels").upsert(rows.slice(i, i + 500));
  labelRows.clear();
}
// Addresses still to look up, kept between calls (filled by snapshots, emptied by lookups)
let labelTodo: string[] = [];
let labelTodoDirty = false;
async function lookupLabels(result: Record<string, unknown>) {
  let n = 0;
  while (labelTodo.length && timeLeft() > 20000) {
    const key = labelTodo[0], [net, addr] = key.split(":");
    let status = 0, body: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://${LABEL_HOST[net]}/api/v2/addresses/${addr}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
      status = res?.status ?? 0; body = res ? await res.json().catch(() => null) : null;
      if (status !== 429 && status !== 0 && status < 500) break;
      if (timeLeft() < 30000) break;
      await sleep(4000 * (attempt + 1));
    }
    if (status === 200 || status === 404) noteLabel(key, status === 200 ? exchangeFromTags(body) : null);
    else break;   // Blockscout unavailable: the rest waits for the next call
    labelTodo.shift(); labelTodoDirty = true; n++;
    await sleep(700);
  }
  if (n || labelTodo.length) result.labels = `${n} looked up, ${labelTodo.length} waiting`;
}

// ---------------- GoldRush (credits counted and capped) ----------------
let grUsage = { day: "", dayCredits: 0, month: "", monthCredits: 0 };
function grAllowed(credits: number) {
  return grUsage.dayCredits + credits <= GR_DAILY_CREDITS && grUsage.monthCredits + credits <= GR_MONTHLY_CREDITS;
}
async function goldrush(chain: Chain, token: string, pageSize: 100 | 1000, blockHeight?: number) {
  const cost = pageSize * 0.02;
  if (!grAllowed(cost)) throw new Error(`goldrush credit cap reached (${grUsage.dayCredits} today, ${grUsage.monthCredits} this month)`);
  const url = `https://api.covalenthq.com/v1/${CHAINS[chain].gr}/tokens/${token}/token_holders_v2/?page-size=${pageSize}` +
    (blockHeight ? `&block-height=${blockHeight}` : "");
  const { status, body } = await getJson(url, { headers: { Authorization: `Bearer ${GOLDRUSH_KEY}` } }, 45000);
  const items = body?.data?.items;
  if (Array.isArray(items)) { const used = items.length * 0.02; grUsage.dayCredits += used; grUsage.monthCredits += used; }
  if (status !== 200 || !Array.isArray(items)) {
    const err = new Error(`goldrush ${status} ${String(body?.error_message ?? "").slice(0, 120)}`) as Error & { status?: number };
    err.status = status; throw err;
  }
  return { items, total: body?.data?.pagination?.total_count ?? null };
}

// Fallback lists (top 100, free)
async function explorerList(chain: Chain, token: string, decimals: number) {
  if (chain === "op") {
    const out: { address: string; raw: bigint }[] = [];
    let q = "";
    for (let page = 0; page < 2; page++) {   // Blockscout: 50 per page
      const { status, body } = await getJson(`https://optimism.blockscout.com/api/v2/tokens/${token}/holders${q}`);
      if (status !== 200 || !Array.isArray(body?.items)) throw new Error(`blockscout ${status}`);
      for (const x of body.items) out.push({ address: String(x.address?.hash ?? "").toLowerCase(), raw: BigInt(x.value ?? "0") });
      if (!body.next_page_params) break;
      q = "?" + new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)])).toString();
    }
    return { list: out, source: "blockscout" };
  }
  const host = chain === "bsc" ? "api.binplorer.com" : "api.ethplorer.io";
  const { status, body } = await getJson(`https://${host}/getTopTokenHolders/${token}?apiKey=${ETHPLORER_KEY}&limit=100`);
  if (status !== 200 || !Array.isArray(body?.holders)) throw new Error(`${host} ${status} ${JSON.stringify(body?.error ?? "").slice(0, 80)}`);
  return { list: body.holders.filter((h: any) => /^0x[0-9a-f]{40}$/i.test(h.address))
    .map((h: any) => ({ address: h.address.toLowerCase(), raw: BigInt(h.rawBalance ?? "0"), pct: +h.share || 0 })), source: host.split(".")[1] };
}

// ---------------- the wider list: top 120 coins of the radar, free sources ----------------
// Ethereum tokens: Blockscout (top 1,000, free); BSC tokens: Binplorer (top 100, free); Solana tokens:
// Solana Tracker (top 1,000). A coin is followed on the chain that holds at least half of its supply
// (on-chain totalSupply against CoinGecko's total supply), so a bridged copy (BNB on Ethereum, PENGU
// on Ethereum...) is never mistaken for the coin. Rebuilt once a week from the radar's latest ranking.
type UniToken = { sym: string; chain: "eth" | "bsc" | "sol"; address: string; decimals: number };
const FIXED = new Set([...Object.keys(SOL_TOKENS), ...Object.keys(ERC20), "ETH", "SEI", "APT", "ALGO", "DOT"]);
const UNIVERSE_TOP = 120, UNIVERSE_EVERY_DAYS = 7;
const CG_CHAIN: [string, "eth" | "bsc" | "sol"][] = [["ethereum", "eth"], ["binance-smart-chain", "bsc"], ["solana", "sol"]];
type Universe = { at: string; tokens: UniToken[]; skipped: Record<string, string> };
async function buildUniverse(): Promise<Universe> {
  const { data: last } = await db.from("momentum_daily").select("day").order("day", { ascending: false }).limit(1);
  const { data: rad } = await db.from("momentum_daily").select("token,rank").eq("day", last?.[0]?.day ?? "").lte("rank", UNIVERSE_TOP).order("rank");
  const want = (rad ?? []).map((r) => r.token as string).filter((x) => !FIXED.has(x));
  if (!want.length) throw new Error("radar ranking not available");
  const cg = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250";
  const markets: any[] = [];
  for (const page of [1, 2]) {
    const { status, body } = await getJson(`${cg}&page=${page}`);
    if (status !== 200 || !Array.isArray(body)) { if (page === 1) throw new Error(`coingecko markets ${status}`); break; }
    markets.push(...body);
    await sleep(2500);
  }
  const { status: ls, body: list } = await getJson("https://api.coingecko.com/api/v3/coins/list?include_platform=true", {}, 45000);
  if (ls !== 200 || !Array.isArray(list)) throw new Error(`coingecko coin list ${ls}`);
  const platforms = new Map((list as any[]).map((c) => [c.id, c.platforms ?? {}]));
  const tokens: UniToken[] = [], skipped: Record<string, string> = {};
  // Candidates: (coin, chain, address) for the three supported chains
  const cands: { sym: string; chain: "eth" | "bsc" | "sol"; address: string; ref: number }[] = [];
  for (const sym of want) {
    const m = markets.find((x) => String(x.symbol).toUpperCase() === sym);
    if (!m) { skipped[sym] = "not in CoinGecko top 500"; continue; }
    const ref = +m.total_supply || +m.circulating_supply || 0, pl = platforms.get(m.id) ?? {};
    const mine = CG_CHAIN.filter(([k]) => typeof pl[k] === "string" && pl[k]).map(([k, c]) => ({ sym, chain: c, address: c === "sol" ? pl[k] : pl[k].toLowerCase(), ref }));
    if (!mine.length) { skipped[sym] = Object.keys(pl).filter(Boolean).length ? `other chain (${Object.keys(pl).filter(Boolean).slice(0, 3).join(", ")})` : "native coin"; continue; }
    if (!ref) { skipped[sym] = "no supply figure"; continue; }
    cands.push(...mine);
  }
  // On-chain supply of each candidate
  const supply = new Map<string, { units: number; decimals: number }>();
  for (const chain of ["eth", "bsc"] as const) {
    const cs = cands.filter((c) => c.chain === chain);
    const res = await rpcBig(CHAINS[chain].pub, cs.flatMap((c) => [{ method: "eth_call", params: [{ to: c.address, data: "0x18160ddd" }, "latest"] },
      { method: "eth_call", params: [{ to: c.address, data: "0x313ce567" }, "latest"] }]));
    cs.forEach((c, i) => { try { const dec = Number(BigInt(res[2 * i + 1]!)); supply.set(`${chain}:${c.address}`, { units: toUnits(BigInt(res[2 * i]!), dec), decimals: dec }); } catch { /* no answer */ } });
  }
  for (const c of cands.filter((x) => x.chain === "sol")) {
    const { body } = await getJson("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: [c.address] }) }, 15000).catch(() => ({ body: null }));
    const v = body?.result?.value;
    if (v) supply.set(`sol:${c.address}`, { units: +v.uiAmountString || 0, decimals: +v.decimals });
    await sleep(400);
  }
  for (const sym of new Set(cands.map((c) => c.sym))) {
    const mine = cands.filter((c) => c.sym === sym);
    let ok = mine.find((c) => (supply.get(`${c.chain}:${c.address}`)?.units ?? 0) >= 0.5 * c.ref);
    // Solana's public node may not answer: a Solana mint is then taken when no EVM copy holds the supply
    const solUnknown = mine.find((c) => c.chain === "sol" && !supply.has(`sol:${c.address}`));
    if (!ok && solUnknown) { ok = solUnknown; supply.set(`sol:${solUnknown.address}`, { units: 0, decimals: 0 }); }
    if (!ok) { skipped[sym] = "bridged copies only (" + mine.map((c) => `${c.chain} ${Math.round((supply.get(`${c.chain}:${c.address}`)?.units ?? 0) / c.ref * 100)}%`).join(", ") + ")"; continue; }
    tokens.push({ sym, chain: ok.chain, address: ok.address, decimals: supply.get(`${ok.chain}:${ok.address}`)!.decimals });
  }
  return { at: new Date().toISOString(), tokens, skipped };
}

// Lists read for a token whose contract check did not finish: kept for the day, read once
let listPending: Record<string, { day: string; list: [string, string][]; source: string }> = {};
let listPendingDirty = false;
async function blockscoutList(address: string) {
  const out: { address: string; raw: bigint }[] = [];
  let q = "";
  for (let page = 0; page < 20; page++) {   // 50 per page: up to 1,000
    let r = { status: 0, body: null as any };
    // Without a key Blockscout limits the call rate: on 429 wait for the window to reset, then retry
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`https://eth.blockscout.com/api/v2/tokens/${address}/holders${q}`, { signal: AbortSignal.timeout(30000) }).catch(() => null);
      r = { status: res?.status ?? 0, body: res ? await res.json().catch(() => null) : null };
      if (r.status !== 429 && r.status !== 0) break;
      const reset = Number(res?.headers.get("x-ratelimit-reset") ?? 0);   // time until the window resets (s or ms)
      const wait = Math.min(20000, reset > 0 ? (reset < 300 ? reset * 1000 : reset) + 250 : 4000 * (attempt + 1));
      if (timeLeft() < wait + 25000) break;
      await sleep(wait);
    }
    const { status, body } = r;
    if (status !== 200 || !Array.isArray(body?.items)) { if (out.length >= 100 && timeLeft() < 25000) break; throw new Error(`blockscout ${status} after ${out.length} holders`); }
    for (const x of body.items) {
      const a = String(x.address?.hash ?? "").toLowerCase();
      out.push({ address: a, raw: BigInt(x.value ?? "0") });
      // The list carries each address's tags: keep the 100 largest and every exchange
      const ex = exchangeFromTags(x.address);
      if (a && (out.length <= LABEL_TOP || ex)) noteLabel(`eth:${a}`, ex);
    }
    if (!body.next_page_params) break;
    q = "?" + new URLSearchParams(Object.entries(body.next_page_params).map(([k, v]) => [k, String(v)])).toString();
    await sleep(700);   // Blockscout's keyless rate limit
  }
  return out;
}
async function fetchUniverse(t: UniToken): Promise<Fetched> {
  if (t.chain === "sol") { const f = await fetchSolana(t.address); f.notes = { ...(f.notes ?? {}), source: "solana tracker" }; return f; }
  const today = new Date().toISOString().slice(0, 10);
  const balanceCall = (w: string) => ({ method: "eth_call", params: [{ to: t.address, data: balanceOfData(w) }, "latest"] });
  let kept = listPending[t.sym]?.day === today ? listPending[t.sym] : null;
  if (!kept) {
    let list: { address: string; raw: bigint; pct?: number }[], source: string;
    if (t.chain === "eth") {
      try { list = await blockscoutList(t.address); source = "blockscout"; }
      catch (e) {
        if (timeLeft() < 30000) throw new Later(`blockscout: ${errMsg(e)}`);   // try Blockscout again next call
        ({ list, source } = await explorerList("eth", t.address, t.decimals));   // Ethplorer: top 100
      }
    } else ({ list, source } = await explorerList("bsc", t.address, t.decimals));
    kept = { day: today, list: list.filter((x) => /^0x[0-9a-f]{40}$/.test(x.address)).map((x) => [x.address, x.raw.toString()]), source };
    listPending[t.sym] = kept; listPendingDirty = true;
  }
  const list = kept.list.map(([address, raw]) => ({ address, raw: BigInt(raw) }));
  const out = await rankEvm(t.chain, list, t.decimals, list.length >= 500 ? TOP_N : 100, { source: kept.source, listed: list.length }, balanceCall);
  delete listPending[t.sym]; listPendingDirty = true;
  return out;
}

// A GoldRush list whose contract check did not finish is kept for the day, so the next call does not
// pay for it again
let grPending: Record<string, { day: string; items: any[]; total: number | null }> = {};
let grPendingDirty = false;
async function fetchErc20(sym: string): Promise<Fetched> {
  const t = ERC20[sym];
  const balanceCall = (w: string) => ({ method: "eth_call", params: [{ to: t.address, data: balanceOfData(w) }, "latest"] });
  if (GOLDRUSH_KEY) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const kept = grPending[sym]?.day === today ? grPending[sym] : null;
      const { items, total } = kept ?? await goldrush(t.chain, t.address, 1000);
      if (!kept) { grPending[sym] = { day: today, items: items.map((x: any) => ({ address: x.address, balance: x.balance, contract_decimals: x.contract_decimals, total_supply: x.total_supply })), total }; grPendingDirty = true; }
      const supply = (() => { try { return BigInt(items[0]?.total_supply ?? "0"); } catch { return 0n; } })();
      const list = items.map((x: any) => { const raw = BigInt(x.balance ?? "0");
        return { address: String(x.address).toLowerCase(), raw, pct: supply > 0n ? Number(raw * 1000000n / supply) / 10000 : 0 }; })
        .filter((x: any) => /^0x[0-9a-f]{40}$/.test(x.address));
      const out = await rankEvm(t.chain, list, items[0]?.contract_decimals ?? t.decimals, TOP_N, { source: "goldrush", total, listed: list.length }, balanceCall);
      delete grPending[sym]; grPendingDirty = true;
      return out;
    } catch (e) {
      if (e instanceof Later) throw e;
      if ((e as any).status !== 406 && !String((e as Error).message).includes("credit cap")) throw e;
      // 406 = GoldRush refuses tokens with very many holders; the cap = out of budget: free top 100
    }
  }
  const { list, source } = await explorerList(t.chain, t.address, t.decimals);
  return await rankEvm(t.chain, list, t.decimals, 100, { source, listed: list.length }, balanceCall);
}

// Native ETH: Bitquery's realtime dataset (addresses active in recent weeks; dormant wallets missing)
async function fetchEth(): Promise<Fetched> {
  if (!BITQUERY_KEY) throw new Error("no BITQUERY_API_KEY");
  const query = `{ EVM(network: eth, dataset: realtime) { Holders(where: {Currency: {SmartContract: {is: "0x"}}}, orderBy: {descending: Balance_Amount}, limit: {count: 300}) { Holder { Address } Balance { Amount } } } }`;
  const { status, body } = await getJson("https://streaming.bitquery.io/graphql", { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BITQUERY_KEY}` }, body: JSON.stringify({ query }) }, 45000);
  const rows = body?.data?.EVM?.Holders;
  if (status !== 200 || !Array.isArray(rows)) throw new Error(`bitquery ${status} ${JSON.stringify(body?.errors ?? body ?? "").slice(0, 120)}`);
  const addrs = rows.map((x: any) => String(x?.Holder?.Address ?? "").toLowerCase()).filter((a: string) => /^0x[0-9a-f]{40}$/.test(a));
  // Balances read from the chain (the list's figure can be stale)
  const bals = await rpcBig(CHAINS.eth.pub, addrs.map((a: string) => ({ method: "eth_getBalance", params: [a, "latest"] })));
  const list = addrs.map((a: string, i: number) => ({ address: a, raw: bals[i] ? BigInt(bals[i]!) : 0n }));
  return await rankEvm("eth", list, 18, 100, { source: "bitquery realtime", listed: list.length },
    (w) => ({ method: "eth_getBalance", params: [w, "latest"] }));
}

// ---------------- Other native coins ----------------
// Sei module accounts (staking pools, fee collector...) hold coins for everyone: address = sha256(name)[:20]
const BECH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32(hrp: string, data: Uint8Array) {
  const conv: number[] = []; let acc = 0, bits = 0;
  for (const b of data) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; conv.push((acc >> bits) & 31); } }
  if (bits) conv.push((acc << (5 - bits)) & 31);
  const polymod = (v: number[]) => { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1;
    for (const x of v) { const top = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((top >> i) & 1) c ^= G[i]; } return c; };
  const hx = [...hrp].map((ch) => ch.charCodeAt(0) >> 5).concat([0], [...hrp].map((ch) => ch.charCodeAt(0) & 31));
  const pm = polymod(hx.concat(conv, [0, 0, 0, 0, 0, 0])) ^ 1;
  const chk = Array.from({ length: 6 }, (_, i) => (pm >> (5 * (5 - i))) & 31);
  return hrp + "1" + conv.concat(chk).map((d) => BECH[d]).join("");
}
const SEI_MODULES = ["bonded_tokens_pool", "not_bonded_tokens_pool", "distribution", "fee_collector", "mint", "gov", "evm", "oracle", "tokenfactory", "wasm", "epoch", "transfer"];
async function seiModuleAddrs() {
  const out = new Set<string>();
  for (const m of SEI_MODULES) out.add(bech32("sei", new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m))).slice(0, 20)));
  return out;
}
async function fetchSei(): Promise<Fetched> {
  const modules = await seiModuleAddrs();
  const rows: any[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 10; page++) {
    const { status, body } = await getJson(`https://api.seistream.app/accounts/top?limit=100&offset=${(page - 1) * 100}`);
    if (status !== 200 || !Array.isArray(body?.items)) { if (page === 1) throw new Error(`seistream ${status}`); break; }
    total = body.pagination?.total ?? total;
    rows.push(...body.items);
    if (!body.pagination?.hasMore) break;
    await sleep(300);
  }
  const seen = new Set<string>();
  const list = rows.filter((x) => typeof x.address === "string" && !seen.has(x.address) && seen.add(x.address));
  const isSys = (a: string) => modules.has(a) || a.length > 45;   // 32-byte addresses are contracts
  const excluded = list.filter((x) => isSys(x.address)).length;
  const ranked: Ranked = list.filter((x) => !isSys(x.address)).map((x) => [x.address, { bal: Number(x.balance) / 1e6, pct: (+x.share || 0) * 100 }] as [string, { bal: number; pct: number }])
    .sort((a, b) => b[1].bal - a[1].bal).slice(0, TOP_N);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} SEI holders`);
  return { ranked, total, excluded, topN: ranked.length >= 500 ? TOP_N : 100, notes: { source: "seistream", listed: list.length, pages: Math.ceil(rows.length / 100) } };
}

const APT_GQL = "https://api.mainnet.aptoslabs.com/v1/graphql";
async function aptQuery(where: string, extra = "") {
  const query = `{ current_fungible_asset_balances(where: {asset_type: {_eq: "0x1::aptos_coin::AptosCoin"}${where}}${extra}) { owner_address amount } }`;
  const { status, body } = await getJson(APT_GQL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
  const rows = body?.data?.current_fungible_asset_balances;
  if (status !== 200 || !Array.isArray(rows)) throw new Error(`aptos indexer ${status} ${JSON.stringify(body?.errors ?? "").slice(0, 100)}`);
  return rows as { owner_address: string; amount: number | string }[];
}
async function fetchApt(): Promise<Fetched> {
  // Sorting every balance times out on the public indexer: only balances above 100k APT are sorted
  const rows: any[] = [];
  for (let off = 0; off < TOP_N; off += 100) {
    let page: any[];
    try { page = await aptQuery(`, amount: {_gt: "10000000000000"}`, `, order_by: {amount: desc}, limit: 100, offset: ${off}`); }
    catch (e) { if (rows.length >= 100) break; throw e; }   // keep the pages already read
    rows.push(...page);
    if (page.length < 100) break;
    await sleep(300);
  }
  const ranked: Ranked = rows.map((x) => [x.owner_address, { bal: Number(x.amount) / 1e8, pct: 0 }] as [string, { bal: number; pct: number }]);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} APT holders`);
  const exact = async (wallets: string[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i < wallets.length; i += 100) {
      const res = await aptQuery(`, owner_address: {_in: ${JSON.stringify(wallets.slice(i, i + 100))}}`);
      for (const x of res) m.set(x.owner_address, Number(x.amount) / 1e8);
      for (const w of wallets.slice(i, i + 100)) if (!m.has(w)) m.set(w, 0);   // no balance row = emptied
    }
    return m;
  };
  return { ranked, total: null, excluded: 0, topN: TOP_N, exact, notes: { source: "aptos indexer", listed: rows.length } };
}

const ALGO_IDX = "https://mainnet-idx.4160.nodely.dev";
async function fetchAlgo(): Promise<Fetched> {
  const accts: any[] = [];
  let next = "";
  for (let page = 0; page < 6; page++) {   // accounts above 200k ALGO (the indexer cannot sort by balance)
    const { status, body } = await getJson(`${ALGO_IDX}/v2/accounts?currency-greater-than=200000000000&limit=1000&exclude=all${next ? `&next=${next}` : ""}`);
    if (status !== 200 || !Array.isArray(body?.accounts)) throw new Error(`algorand indexer ${status}`);
    accts.push(...body.accounts);
    if (!body["next-token"] || !body.accounts.length) break;
    next = encodeURIComponent(body["next-token"]);
    await sleep(300);
  }
  const ranked: Ranked = accts.filter((a) => !a.deleted).map((a) => [a.address, { bal: Number(a.amount) / 1e6, pct: 0 }] as [string, { bal: number; pct: number }])
    .sort((a, b) => b[1].bal - a[1].bal).slice(0, TOP_N);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} ALGO holders`);
  const exact = async (wallets: string[]) => {
    const m = new Map<string, number>();
    for (const w of wallets.slice(0, 60)) {   // a few per day; the rest use the cut-off estimate
      const { status, body } = await getJson(`${ALGO_IDX}/v2/accounts/${w}?exclude=all`, {}, 15000).catch(() => ({ status: 0, body: null }));
      if (status === 200 && body?.account) m.set(w, Number(body.account.amount) / 1e6);
      await sleep(150);
    }
    return m;
  };
  return { ranked, total: null, excluded: 0, topN: ranked.length >= 500 ? TOP_N : 100, exact, notes: { source: "algorand indexer (>200k ALGO)", listed: accts.length } };
}

// DOT: balances live on Polkadot Asset Hub since the 2025 migration. Top list from Subscan through the
// PubFi gateway; exact balances of wallets that left the list read from the chain via OnFinality.
const PUBFI = "https://api.pubfi.ai/v1/gateway/subscan/assethub-polkadot";
// System accounts (pallets, nomination pools, parachain sovereign accounts) start with these bytes
const DOT_SYSTEM = ["modl", "para", "sibl"];
const ss58Pub = (a: string) => { try { const b = b58(a); return b.length === 35 ? b.slice(1, 33) : null; } catch { return null; } };
const isDotSystem = (a: string) => { const p = ss58Pub(a); return !p || DOT_SYSTEM.includes(new TextDecoder().decode(p.slice(0, 4))); };
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
// System.Account storage key = twox128("System") + twox128("Account") + blake2_128(pub) + pub
const SYSTEM_ACCOUNT = "26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";
const accountKey = (pub: Uint8Array) => "0x" + SYSTEM_ACCOUNT + hex(blake2b(pub, { dkLen: 16 })) + hex(pub);
const leU128 = (h: string, at: number) => { let n = 0n; for (let i = 15; i >= 0; i--) n = n * 256n + BigInt(parseInt(h.substr((at + i) * 2, 2), 16)); return n; };
// AccountInfo: nonce, consumers, providers, sufficients (u32 each), then free, reserved (u128)
const dotTotal = (h: string) => { const x = h.slice(2); return x.length >= 64 + 64 ? Number(leU128(x, 16) + leU128(x, 32)) / 1e10 : 0; };
async function dotBalances(wallets: string[]) {
  const m = new Map<string, number>();
  if (!ONFINALITY_KEY) return m;
  const url = `https://statemint.api.onfinality.io/rpc?apikey=${ONFINALITY_KEY}`;
  const keyed = wallets.map((w) => [w, ss58Pub(w)] as const).filter(([, p]) => p).map(([w, p]) => [w, accountKey(p!)] as const);
  for (let i = 0; i < keyed.length; i += 100) {
    const part = keyed.slice(i, i + 100);
    const { status, body } = await getJson(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state_queryStorageAt", params: [part.map(([, k]) => k)] }) });
    const changes = body?.result?.[0]?.changes;
    if (status !== 200 || !Array.isArray(changes)) { rpcErrors["statemint.api.onfinality.io"] ??= errMsg(`${status} ${JSON.stringify(body?.error ?? "").slice(0, 80)}`); continue; }
    const byKey = new Map(changes.map(([k, v]: [string, string | null]) => [k, v]));
    for (const [w, k] of part) if (byKey.has(k)) m.set(w, byKey.get(k) ? dotTotal(byKey.get(k)!) : 0);   // no entry = account emptied
  }
  return m;
}
async function fetchDot(): Promise<Fetched> {
  if (!SUBSCAN_KEY) throw new Error("no SUBSCAN_API_KEY");
  const rows: any[] = [];
  let total: number | null = null;
  // PubFi free routes: at most 25 rows per call and 5 calls a second
  for (let page = 0; page < 42 && timeLeft() > 20000; page++) {
    let r = { status: 0, body: null as any };
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await getJson(`${PUBFI}/api/v2/scan/accounts`, { method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SUBSCAN_KEY}` },
        body: JSON.stringify({ row: 25, page, order: "desc", order_field: "balance" }) }).catch(() => ({ status: 0, body: null }));
      if (r.status !== 429 && r.status !== 0) break;
      await sleep(1500 * (attempt + 1));
    }
    const list = r.body?.data?.list;
    if (r.status !== 200 || r.body?.code !== 0 || !Array.isArray(list)) {
      if (rows.length >= 100) break;   // keep the pages already read
      throw new Error(`subscan ${r.status} ${String(r.body?.message ?? r.body?.error?.message ?? r.body?.error ?? "").slice(0, 100)}`);
    }
    total = r.body.data.count ?? total;
    rows.push(...list);
    if (list.length < 25) break;
    await sleep(250);
  }
  const seen = new Set<string>();
  const list = rows.filter((x) => typeof x.address === "string" && !seen.has(x.address) && seen.add(x.address));
  const sys = (x: any) => x.is_evm_contract || isDotSystem(x.address);
  const ranked: Ranked = list.filter((x) => !sys(x)).map((x) => [x.address, { bal: Number(x.balance), pct: 0 }] as [string, { bal: number; pct: number }])
    .filter(([, x]) => Number.isFinite(x.bal) && x.bal > 0).sort((a, b) => b[1].bal - a[1].bal).slice(0, TOP_N);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} DOT holders`);
  return { ranked, total, excluded: list.filter(sys).length, topN: ranked.length >= 500 ? TOP_N : 100, exact: ONFINALITY_KEY ? dotBalances : undefined,
    notes: { source: "subscan (pubfi) asset hub", listed: list.length, exact_from: ONFINALITY_KEY ? "onfinality" : null } };
}

// ---------------- bands ----------------
function gini(xs: number[]) {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
}
type Prev = { wallet: string; balance: number; rank: number }[];
// prev: the previous snapshot's wallets. Wallets that left the list count at their exact balance when
// known, otherwise at most today's cut-off balance (a conservative estimate).
function bandRows(token: string, day: string, ranked: Ranked, topN: number, prev: Prev, exactLeft: Map<string, number>) {
  const cutoff = ranked[ranked.length - 1][1].bal;
  const today = new Map(ranked.map(([w, x], i) => [w, { bal: x.bal, rank: i + 1 }]));
  const prevMap = new Map(prev.map((p) => [p.wallet, p]));
  return BANDS.filter(([, lo]) => lo <= Math.min(topN, ranked.length)).map(([band, lo, hi]) => {
    const now = ranked.slice(lo - 1, hi);
    const balance = now.reduce((s, [, x]) => s + x.bal, 0);
    const entered = prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null;
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      net = 0; left = 0;
      for (const p of prev) {
        if (p.rank < lo || p.rank > hi) continue;
        const t = today.get(p.wallet);
        if (!t) left++;
        net += (t ? t.bal : exactLeft.get(p.wallet) ?? Math.min(cutoff, p.balance)) - p.balance;
      }
    }
    return { token, day, band, balance, net, left_top: left, entered };
  });
}
// Exchange wallets apart: 'cex' = wallets labelled as an exchange (deposits in = coins likely to be
// sold, withdrawals = coins taken off exchanges), 'whale_ex' = the 50 largest wallets that are not an
// exchange. Same method as the bands: yesterday's members, their balance today minus yesterday.
function labelBands(token: string, day: string, ranked: Ranked, prev: Prev, exactLeft: Map<string, number>, isEx: (w: string) => boolean) {
  const cutoff = ranked[ranked.length - 1][1].bal;
  const today = new Map(ranked.map(([w, x]) => [w, x.bal]));
  const cohort = (ps: Prev) => {
    if (!prev.length) return { net: null as number | null, left: null as number | null };
    let net = 0, left = 0;
    for (const p of ps) { const t = today.get(p.wallet); if (t === undefined) left++; net += (t ?? exactLeft.get(p.wallet) ?? Math.min(cutoff, p.balance)) - p.balance; }
    return { net, left };
  };
  const whalesNow = ranked.filter(([w]) => !isEx(w)).slice(0, 50);
  const whalesPrev = [...prev].sort((a, b) => a.rank - b.rank).filter((p) => !isEx(p.wallet)).slice(0, 50);
  const cexNow = ranked.filter(([w]) => isEx(w)), cexPrev = prev.filter((p) => isEx(p.wallet));
  const w = cohort(whalesPrev), c = cohort(cexPrev);
  const prevW = new Set(whalesPrev.map((p) => p.wallet)), prevC = new Set(cexPrev.map((p) => p.wallet));
  return [
    { token, day, band: "whale_ex", balance: whalesNow.reduce((s, [, x]) => s + x.bal, 0), net: w.net, left_top: w.left,
      entered: prev.length ? whalesNow.filter(([a]) => !prevW.has(a)).length : null },
    { token, day, band: "cex", balance: cexNow.reduce((s, [, x]) => s + x.bal, 0), net: c.net, left_top: c.left,
      entered: prev.length ? cexNow.filter(([a]) => !prevC.has(a)).length : null },
  ];
}
// Share of supply only where the source gives it (null otherwise: the page then shows "–")
function dailyRow(token: string, day: string, price: number | null, f: { ranked: Ranked; total: number | null; excluded: number; notes?: Record<string, unknown> }) {
  const r = f.ranked;
  const share = (n: number) => { const v = r.slice(0, n).reduce((s, [, x]) => s + x.pct, 0); return v > 0 ? v : null; };
  return { token, day, price, holders: f.total, top10_pct: share(10), top100_pct: share(100), gini: gini(r.map(([, x]) => x.bal)), excluded: f.excluded,
    source: String(f.notes?.source ?? (token in SOL_TOKENS ? "solana tracker" : "")) || null, depth: r.length };
}

async function snapshot(token: string, f: Fetched, day: string, price: number | null) {
  const { data: prevRows, error: pErr } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", token);
  if (pErr) throw pErr;
  const prev = (prevRows ?? []).filter((p) => p.day < day);
  const today = new Set(f.ranked.map(([w]) => w));
  const leftWallets = prev.filter((p) => !today.has(p.wallet)).map((p) => p.wallet);
  const exactLeft = f.exact && leftWallets.length ? await f.exact(leftWallets).catch(() => new Map<string, number>()) : new Map<string, number>();
  let bands: any[] = bandRows(token, day, f.ranked, f.topN, prev, exactLeft);
  // Exchange labels (EVM): the extra bands only when the 100 largest wallets are nearly all checked
  let exOf: (w: string) => string | null = () => null, labelNote: unknown = null;
  if (f.labelChain) {
    const lc = f.labelChain, keys = [...new Set([...f.ranked.map(([w]) => w), ...prev.map((p) => p.wallet)])].map((w) => labelKey(lc, w));
    await loadLabels(keys);
    exOf = (w) => labels.get(labelKey(lc, w))?.exchange ?? null;
    const top = f.ranked.slice(0, LABEL_TOP).map(([w]) => labelKey(lc, w));
    const todo = top.filter((k) => { const l = labels.get(k); return !l || Date.now() - l.at > LABEL_TTL_MS; });
    for (const k of todo) if (!labelTodo.includes(k)) { labelTodo.push(k); labelTodoDirty = true; }
    const known = top.length - todo.length;
    labelNote = { checked: `${known}/${top.length}`, exchanges: f.ranked.filter(([w]) => exOf(w)).length };
    if (known >= 0.9 * top.length) bands = [...bands, ...labelBands(token, day, f.ranked, prev, exactLeft, (w) => !!exOf(w))];
  }
  const daily = dailyRow(token, day, price, f);
  let { error } = await db.from("holder_bands").upsert(bands);
  if (error) throw error;
  ({ error } = await db.from("holder_daily").upsert(daily));
  if (error) throw error;
  // Keep only the newest snapshot per token (it is what tomorrow is compared with)
  ({ error } = await db.from("holder_snapshot").delete().eq("token", token));
  if (error) throw error;
  for (let i = 0; i < f.ranked.length; i += 500) {
    ({ error } = await db.from("holder_snapshot").insert(f.ranked.slice(i, i + 500).map(([wallet, x], j) => ({ token, wallet, balance: x.bal, rank: i + j + 1, day, exchange: exOf(wallet) }))));
    if (error) throw error;
  }
  return { holders: f.ranked.length, excluded: f.excluded, compared: prev.length > 0, exact_left: exactLeft.size, left: leftWallets.length, labels: labelNote, ...(f.notes ?? {}) };
}

// ---------------- history (GoldRush tokens) ----------------
// Block at a time: secant steps on block timestamps (any chain, whatever its block time)
async function blockAt(chain: Chain, ts: number) {
  const rpc = async (method: string, params: unknown[]) => (await rpcBig(CHAINS[chain].pub, [{ method, params }]))[0];
  const tsOf = async (n: number) => { const r = await getJson(CHAINS[chain].pub, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x" + n.toString(16), false] }) });
    return parseInt(r.body?.result?.timestamp ?? "0x0", 16); };
  const hi = parseInt((await rpc("eth_blockNumber", [])) ?? "0x0", 16);
  if (!hi) throw new Error(`no block number on ${chain}`);
  let b1 = hi, t1 = await tsOf(hi), b0 = Math.max(1, hi - 100000), t0 = await tsOf(b0);
  for (let i = 0; i < 8; i++) {
    if (t1 === t0) break;
    const b = Math.max(1, Math.min(hi, Math.round(b1 + (ts - t1) * (b1 - b0) / (t1 - t0))));
    const t = await tsOf(b);
    if (Math.abs(t - ts) <= 30) return b;
    b0 = b1; t0 = t1; b1 = b; t1 = t;
  }
  return b1;
}
async function dailyCloses(sym: string) {
  const { status, body } = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${sym}USDT&interval=1d&limit=${HISTORY_DAYS + 5}`);
  const m = new Map<string, number>();
  // A snapshot at 00:07 UTC on day D is priced at the close of D-1 (= the open of D)
  if (status === 200 && Array.isArray(body)) for (const k of body) m.set(new Date(k[0]).toISOString().slice(0, 10), +k[1]);
  return m;
}
async function backfill(day: string, result: Record<string, unknown>) {
  if (!GOLDRUSH_KEY) return;
  const st = (await loadState(["holders_backfill"])).holders_backfill ?? {};
  for (const [sym, t] of Object.entries(ERC20)) {
    if (timeLeft() < 25000) break;
    const s = st[sym] ?? { next: new Date(Date.parse(day) - HISTORY_DAYS * 864e5).toISOString().slice(0, 10), prev: [] as Prev, done: false };
    if (s.done || s.skip) continue;
    const { data: existing } = await db.from("holder_daily").select("day").eq("token", sym).lt("day", day);
    const have = new Set((existing ?? []).map((r) => r.day));
    const px = await dailyCloses(sym);
    let n = 0;
    try {
      while (s.next < day && timeLeft() > 25000 && grAllowed(2)) {
        const d = s.next;
        if (!have.has(d)) {
          const block = await blockAt(t.chain, Date.parse(d) / 1000 + 7 * 60);
          const { items, total } = await goldrush(t.chain, t.address, 100, block);
          const supply = (() => { try { return BigInt(items[0]?.total_supply ?? "0"); } catch { return 0n; } })();
          const list = items.map((x: any) => { const raw = BigInt(x.balance ?? "0");
            return { address: String(x.address).toLowerCase(), raw, pct: supply > 0n ? Number(raw * 1000000n / supply) / 10000 : 0 }; });
          const { isContract } = await contractsIn(t.chain, list.map((x) => x.address));
          const ranked: Ranked = list.filter((x) => !isContract(x.address) && x.raw > 0n)
            .map((x) => [x.address, { bal: toUnits(x.raw, items[0]?.contract_decimals ?? t.decimals), pct: x.pct }] as [string, { bal: number; pct: number }])
            .sort((a, b) => b[1].bal - a[1].bal);
          if (ranked.length >= 10) {
            const bands = bandRows(sym, d, ranked, 100, s.prev, new Map());
            const daily = dailyRow(sym, d, px.get(d) ?? null, { ranked, total, excluded: list.length - ranked.length, notes: { source: "goldrush history" } });
            const { error: e1 } = await db.from("holder_bands").upsert(bands);
            const { error: e2 } = await db.from("holder_daily").upsert(daily);
            if (e1 || e2) throw e1 ?? e2;
            s.prev = ranked.map(([wallet, x], i) => ({ wallet, balance: x.bal, rank: i + 1 }));
          }
          n++;
        } else s.prev = [];   // a day already stored has no wallet list here: the next day starts fresh
        s.next = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10);
      }
      if (s.next >= day) { s.done = true; s.prev = []; }
    } catch (e) {
      if ((e as any).status === 406) { s.skip = true; s.prev = []; }   // GoldRush refuses this token
      else if (!(e instanceof Later)) result[`${sym}_history_error`] = errMsg(e);
    }
    st[sym] = s;
    result[`${sym}_history`] = s.done ? "done" : s.skip ? "not available" : `up to ${s.next} (+${n})`;
    await saveState("holders_backfill", st);
  }
}

// ---------------- main ----------------
const FIXED_JOBS: [string, () => Promise<Fetched>][] = [
  ...Object.entries(SOL_TOKENS).map(([t, mint]) => [t, () => fetchSolana(mint)] as [string, () => Promise<Fetched>]),
  ...Object.keys(ERC20).map((t) => [t, () => fetchErc20(t)] as [string, () => Promise<Fetched>]),
  ["ETH", fetchEth], ["SEI", fetchSei], ["APT", fetchApt], ["ALGO", fetchAlgo], ["DOT", fetchDot],
];
async function prices(): Promise<Record<string, number>> {
  const { body } = await getJson("https://data-api.binance.vision/api/v3/ticker/price", {}, 15000).catch(() => ({ body: null }));
  const out: Record<string, number> = {};
  if (Array.isArray(body)) for (const p of body) if (p.symbol.endsWith("USDT")) out[p.symbol.slice(0, -4)] = +p.price;
  return out;
}

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
  deadline = started + RUN_BUDGET_MS;
  const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
  const st = await loadState(["holders_lock", "holders_status", "evm_code_cache", "goldrush_usage", "goldrush_pending", "holders_pending", "holder_universe", "labels_todo"]);
  // One run at a time; the URL is public, so a repeated call only finds today's work done
  if (st.holders_lock?.at && Date.now() - Date.parse(st.holders_lock.at) < 160000) return Response.json({ ok: false, skipped: "busy" });
  await saveState("holders_lock", { at: new Date().toISOString() });
  codeCache = st.evm_code_cache ?? {};
  grPending = st.goldrush_pending ?? {};
  listPending = st.holders_pending ?? {};
  labelTodo = Array.isArray(st.labels_todo) ? st.labels_todo : [];
  const u = st.goldrush_usage ?? {};
  grUsage = { day, dayCredits: u.day === day ? u.dayCredits : 0, month, monthCredits: u.month === month ? u.monthCredits : 0 };
  const result: Record<string, unknown> = st.holders_status?.day === day ? { ...st.holders_status.result } : {};
  try {
    const { data: done } = await db.from("holder_daily").select("token").eq("day", day);
    const doneSet = new Set((done ?? []).map((d) => d.token));
    const px = await prices();
    // The wider list: rebuilt once a week (kept as it was if CoinGecko is unavailable)
    let uni: Universe | null = st.holder_universe ?? null;
    if (!uni || Date.now() - Date.parse(uni.at) > UNIVERSE_EVERY_DAYS * 864e5) {
      try { uni = await buildUniverse(); await saveState("holder_universe", uni); result.universe = { at: uni.at, tokens: uni.tokens.length, skipped: Object.keys(uni.skipped).length }; }
      catch (e) { result.universe_error = errMsg(e); }
    }
    const JOBS = [...FIXED_JOBS, ...(uni?.tokens ?? []).filter((t) => !FIXED.has(t.sym)).map((t) => [t.sym, () => fetchUniverse(t)] as [string, () => Promise<Fetched>])];
    for (const [token, fetcher] of JOBS) {
      if (doneSet.has(token)) continue;
      const need = token === "DOT" ? SUBSCAN_KEY : token === "ETH" ? BITQUERY_KEY : "x";
      if (!need) { result[token] = "needs API key"; continue; }
      if (timeLeft() < 30000) { result[token] = "next call"; continue; }
      try { result[token] = await snapshot(token, await fetcher(), day, px[token] ?? null); }
      catch (e) { result[token] = e instanceof Later ? `continuing next call: ${e.message}` : { error: errMsg(e) }; }
    }
    if (timeLeft() > 30000) await backfill(day, result);
    if (timeLeft() > 25000) await lookupLabels(result);
  } finally {
    if (codeCacheDirty) await saveState("evm_code_cache", codeCache);
    if (grPendingDirty) await saveState("goldrush_pending", grPending);
    if (listPendingDirty) await saveState("holders_pending", listPending);
    await saveLabels().catch(() => {});
    if (labelTodoDirty) await saveState("labels_todo", labelTodo);
    await saveState("goldrush_usage", grUsage);
    await saveState("holders_status", { at: new Date().toISOString(), day, ms: Date.now() - started, result, goldrush_credits: grUsage });
    await saveState("holders_lock", { at: null });
  }
  return Response.json({ ok: true, day, ms: Date.now() - started, result, goldrush_credits: grUsage });
});

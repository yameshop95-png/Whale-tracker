// Holder bands: every day, snapshot the largest holders of a set of coins and record, per rank band,
// how much the band's wallets added or cut since the previous snapshot.
//
// Sources (one daily call per coin unless noted):
// - Solana SPL (PYTH, PENGU, TRUMP, RAY, BOME): Solana Tracker, top 1,000 accounts.
// - ERC-20 / BEP-20 (ENA, POL, ONDO on Ethereum; OP on Optimism; ASTER, CAKE on BSC): GoldRush
//   top 1,000 holders (with GOLDRUSH_API_KEY); if GoldRush refuses a token (too many holders) or has
//   no key: Ethplorer / Binplorer / Blockscout top 100.
// - Native coins: ETH (Bitquery realtime list, BITQUERY_API_KEY), SEI (Seistream), APT (Aptos Labs
//   indexer), ALGO (Algorand indexer via Nodely), DOT (Subscan, SUBSCAN_API_KEY).
//
// Contracts are left out on EVM chains (pools, staking, bridges, safes): each address is checked on two
// nodes (publicnode + Infura) once and the answer is cached; an address without two answers is not used.
//
// pg_cron calls this every 10 minutes from 00:07 to 01:57 UTC. Each call has a time budget and only
// does coins not yet done that day, so a slow day finishes on a later call. With time left, it rebuilds
// up to 90 days of history for the GoldRush tokens (holders at a past block), a few days per call.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { ed25519 } from "npm:@noble/curves@1.4.0/ed25519";

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
const SUBSCAN_KEY = env("SUBSCAN_API_KEY");

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
const CHAINS: Record<Chain, { gr: string; infura: string; pub: string }> = {
  eth: { gr: "eth-mainnet", infura: "mainnet", pub: "https://ethereum-rpc.publicnode.com" },
  op: { gr: "optimism-mainnet", infura: "optimism-mainnet", pub: "https://optimism-rpc.publicnode.com" },
  bsc: { gr: "bsc-mainnet", infura: "bsc-mainnet", pub: "https://bsc-rpc.publicnode.com" },
};
// Contract addresses checked against CoinGecko's platform list when added
const ERC20: Record<string, { chain: Chain; address: string; decimals: number }> = {
  ENA: { chain: "eth", address: "0x57e114b691db790c35207b2e685d4a43181e6061", decimals: 18 },
  POL: { chain: "eth", address: "0x455e53cbb86018ac2b8092fdcd39d8444affc3f6", decimals: 18 },
  ONDO: { chain: "eth", address: "0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3", decimals: 18 },
  OP: { chain: "op", address: "0x4200000000000000000000000000000000000042", decimals: 18 },
  ASTER: { chain: "bsc", address: "0x000ae314e2a2172a039b26378814c252734f556a", decimals: 18 },
  CAKE: { chain: "bsc", address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", decimals: 18 },
};
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000]];
const FETCH_N = 2500;   // Solana accounts fetched: staking programs hold many top accounts

const SECRETS = [ST_KEY, INFURA_KEY, ETHPLORER_KEY, BITQUERY_KEY, GOLDRUSH_KEY, SUBSCAN_KEY].filter((k) => k.length > 8);
const errMsg = (e: unknown) => {
  let m = e instanceof Error ? e.message : String(e);
  for (const k of SECRETS) m = m.split(k).join("***");
  return m.slice(0, 220);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Ranked = [string, { bal: number; pct: number }][];
type Fetched = { ranked: Ranked; total: number | null; excluded: number; topN: number;
  exact?: (wallets: string[]) => Promise<Map<string, number>>; notes?: Record<string, unknown> };
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
const infuraUrl = (c: Chain) => `https://${CHAINS[c].infura}.infura.io/v3/${INFURA_KEY}`;
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
// Infura answers only part of a batch, silently: single requests, 4 at a time, missing ones retried
async function rpcSingles(url: string, calls: { method: string; params: unknown[] }[]) {
  const host = new URL(url).host;
  const out: (string | undefined)[] = Array.from({ length: calls.length }, () => undefined);
  const one = async (id: number) => {
    try {
      const { status, body: x } = await getJson(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, ...calls[id] }) }, 15000);
      if (x && !x.error && typeof x.result === "string") out[id] = x.result;
      else rpcErrors[host] ??= errMsg(`${status} ${JSON.stringify(x?.error ?? x).slice(0, 100)}`);
    } catch (e) { rpcErrors[host] ??= errMsg(e); }
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
    const [pub, inf] = await Promise.all([rpcBig(CHAINS[chain].pub, calls), INFURA_KEY ? rpcSingles(infuraUrl(chain), calls) : Promise.resolve(calls.map(() => undefined))]);
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
  return { ranked, total: (extra.total as number) ?? null, excluded: contracts.length, topN, exact,
    notes: { ...extra, total: undefined, contract_check: stats, contracts: contracts.slice(0, 20), rpc_errors: { ...rpcErrors } } };
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

async function fetchDot(): Promise<Fetched> {
  if (!SUBSCAN_KEY) throw new Error("no SUBSCAN_API_KEY");
  const rows: any[] = [];
  for (let page = 0; page < 10; page++) {
    const { status, body } = await getJson("https://polkadot.api.subscan.io/api/v2/scan/accounts", { method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": SUBSCAN_KEY },
      body: JSON.stringify({ row: 100, page, order: "desc", order_field: "balance" }) });
    const list = body?.data?.list;
    if (status !== 200 || body?.code !== 0 || !Array.isArray(list)) throw new Error(`subscan ${status} ${String(body?.message ?? "").slice(0, 100)}`);
    rows.push(...list);
    if (list.length < 100) break;
    await sleep(600);
  }
  const ranked: Ranked = rows.map((x) => [String(x.address ?? x.account_display?.address ?? ""), { bal: Number(x.balance), pct: 0 }] as [string, { bal: number; pct: number }])
    .filter(([a, x]) => a && Number.isFinite(x.bal)).sort((a, b) => b[1].bal - a[1].bal).slice(0, TOP_N);
  if (ranked.length < 10) throw new Error(`only ${ranked.length} DOT holders`);
  return { ranked, total: null, excluded: 0, topN: ranked.length >= 500 ? TOP_N : 100, notes: { source: "subscan", listed: rows.length } };
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
// Share of supply only where the source gives it (null otherwise: the page then shows "–")
function dailyRow(token: string, day: string, price: number | null, f: { ranked: Ranked; total: number | null; excluded: number }) {
  const r = f.ranked;
  const share = (n: number) => { const v = r.slice(0, n).reduce((s, [, x]) => s + x.pct, 0); return v > 0 ? v : null; };
  return { token, day, price, holders: f.total, top10_pct: share(10), top100_pct: share(100), gini: gini(r.map(([, x]) => x.bal)), excluded: f.excluded };
}

async function snapshot(token: string, f: Fetched, day: string, price: number | null) {
  const { data: prevRows, error: pErr } = await db.from("holder_snapshot").select("wallet,balance,rank,day").eq("token", token);
  if (pErr) throw pErr;
  const prev = (prevRows ?? []).filter((p) => p.day < day);
  const today = new Set(f.ranked.map(([w]) => w));
  const leftWallets = prev.filter((p) => !today.has(p.wallet)).map((p) => p.wallet);
  const exactLeft = f.exact && leftWallets.length ? await f.exact(leftWallets).catch(() => new Map<string, number>()) : new Map<string, number>();
  const bands = bandRows(token, day, f.ranked, f.topN, prev, exactLeft);
  const daily = dailyRow(token, day, price, f);
  let { error } = await db.from("holder_bands").upsert(bands);
  if (error) throw error;
  ({ error } = await db.from("holder_daily").upsert(daily));
  if (error) throw error;
  // Keep only the newest snapshot per token (it is what tomorrow is compared with)
  ({ error } = await db.from("holder_snapshot").delete().eq("token", token));
  if (error) throw error;
  for (let i = 0; i < f.ranked.length; i += 500) {
    ({ error } = await db.from("holder_snapshot").insert(f.ranked.slice(i, i + 500).map(([wallet, x], j) => ({ token, wallet, balance: x.bal, rank: i + j + 1, day }))));
    if (error) throw error;
  }
  return { holders: f.ranked.length, excluded: f.excluded, compared: prev.length > 0, exact_left: exactLeft.size, left: leftWallets.length, ...(f.notes ?? {}) };
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
            const daily = dailyRow(sym, d, px.get(d) ?? null, { ranked, total, excluded: list.length - ranked.length });
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
const JOBS: [string, () => Promise<Fetched>][] = [
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

Deno.serve(async () => {
  const started = Date.now();
  deadline = started + RUN_BUDGET_MS;
  const day = new Date().toISOString().slice(0, 10), month = day.slice(0, 7);
  const st = await loadState(["holders_lock", "holders_status", "evm_code_cache", "goldrush_usage", "goldrush_pending"]);
  // One run at a time; the URL is public, so a repeated call only finds today's work done
  if (st.holders_lock?.at && Date.now() - Date.parse(st.holders_lock.at) < 160000) return Response.json({ ok: false, skipped: "busy" });
  await saveState("holders_lock", { at: new Date().toISOString() });
  codeCache = st.evm_code_cache ?? {};
  grPending = st.goldrush_pending ?? {};
  const u = st.goldrush_usage ?? {};
  grUsage = { day, dayCredits: u.day === day ? u.dayCredits : 0, month, monthCredits: u.month === month ? u.monthCredits : 0 };
  const result: Record<string, unknown> = st.holders_status?.day === day ? { ...st.holders_status.result } : {};
  try {
    const { data: done } = await db.from("holder_daily").select("token").eq("day", day);
    const doneSet = new Set((done ?? []).map((d) => d.token));
    const px = await prices();
    for (const [token, fetcher] of JOBS) {
      if (doneSet.has(token)) continue;
      const need = token === "DOT" ? SUBSCAN_KEY : token === "ETH" ? BITQUERY_KEY : "x";
      if (!need) { result[token] = "needs API key"; continue; }
      if (timeLeft() < 30000) { result[token] = "next call"; continue; }
      try { result[token] = await snapshot(token, await fetcher(), day, px[token] ?? null); }
      catch (e) { result[token] = e instanceof Later ? `continuing next call: ${e.message}` : { error: errMsg(e) }; }
    }
    if (timeLeft() > 30000) await backfill(day, result);
  } finally {
    if (codeCacheDirty) await saveState("evm_code_cache", codeCache);
    if (grPendingDirty) await saveState("goldrush_pending", grPending);
    await saveState("goldrush_usage", grUsage);
    await saveState("holders_status", { at: new Date().toISOString(), day, ms: Date.now() - started, result, goldrush_credits: grUsage });
    await saveState("holders_lock", { at: null });
  }
  return Response.json({ ok: true, day, ms: Date.now() - started, result, goldrush_credits: grUsage });
});

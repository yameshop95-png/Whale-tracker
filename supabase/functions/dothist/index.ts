// DOT holder history (one-off backfill): the live DOT snapshots (Subscan) start on 2026-11-01, so the 180
// days before are rebuilt from the balances of today's top wallets at past blocks of Polkadot Asset Hub,
// read from OnFinality's archive node (ONFINALITY_API_KEY, the same as the holders function), 100 accounts
// per call (state_queryStorageAt on System.Account). Balance = free + reserved, as in the live snapshots.
// Each day is taken at ~01:00 UTC (when the live snapshot is taken); the block is found from the chain's
// own timestamps. Same bands and method as the live snapshots. Limit (said on the page): only today's top
// wallets are followed back, so wallets that were large then and have emptied since are missing.
// Called by pg_cron every 3 minutes until done; then it does nothing.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { blake2b } from "npm:@noble/hashes@1.4.0/blake2b";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const KEY = (Deno.env.get("ONFINALITY_API_KEY") ?? "").trim();
const RPC = `https://statemint.api.onfinality.io/rpc?apikey=${KEY}`;
const DAYS = 180, BUDGET_MS = 110_000;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];
const SOURCE = "onfinality asset hub (lịch sử dựng lại từ số dư của ví lớn hiện tại)";
const mask = (s: string) => KEY.length > 8 ? s.split(KEY).join("***") : s;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const loadState = async (key: string) => (await db.from("collector_state").select("value").eq("key", key).maybeSingle()).data?.value ?? {};
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(s: string) {
  let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error("b58"); n = n * 58n + BigInt(i); }
  const out: number[] = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c === "1") out.unshift(0); else break; }
  return new Uint8Array(out);
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const SYSTEM_ACCOUNT = "26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9";
const TS_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
const accountKey = (addr: string) => { const b = b58(addr); if (b.length !== 35) return null; const pub = b.slice(1, 33); return "0x" + SYSTEM_ACCOUNT + hex(blake2b(pub, { dkLen: 16 })) + hex(pub); };
const leU = (h: string, at: number, len: number) => { let n = 0n; for (let i = len - 1; i >= 0; i--) n = n * 256n + BigInt(parseInt(h.substr((at + i) * 2, 2), 16)); return n; };
// AccountInfo: nonce, consumers, providers, sufficients (u32 each), then free, reserved (u128)
const dotTotal = (v: string) => { const x = v.slice(2); return x.length >= 128 ? Number(leU(x, 16, 16) + leU(x, 32, 16)) / 1e10 : 0; };

async function rpc(method: string, params: unknown[]) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30000) });
      const j: any = await r.json().catch(() => null);
      if (r.status === 200 && j && !j.error) return j.result;
      if (i === 2) throw new Error(`${method} ${r.status} ${JSON.stringify(j?.error ?? "").slice(0, 100)}`);
    } catch (e) { if (i === 2) throw new Error(mask(String(e)).slice(0, 160)); }
    await sleep(5000 * (i + 1));   // OnFinality's rate limit (429): back off
  }
}
const tsAt = async (n: number) => { await sleep(150); const h = await rpc("chain_getBlockHash", [n]); const t = await rpc("state_getStorage", [TS_NOW, h]); return { n, h: h as string, t: Number(leU(String(t).slice(2), 0, 8)) }; };
// Last block at or before time t: secant steps on the chain's own timestamps (block time has changed over time)
async function blockAt(t: number, hint?: { n: number; t: number }) {
  let a: { n: number; t: number }, b: { n: number; t: number };
  if (hint) { a = hint; b = await tsAt(hint.n + Math.round((t - hint.t) / 6000)); }   // from the day before
  else { const head = await rpc("chain_getHeader", []); b = await tsAt(parseInt(head.number, 16)); a = await tsAt(b.n - 50000); }
  if (a.n === b.n) a = await tsAt(b.n - 1000);
  for (let i = 0; i < 12; i++) {
    const rate = (b.t - a.t) / (b.n - a.n);
    const n = Math.max(1, Math.round(b.n - (b.t - t) / rate));
    const c = await tsAt(n);
    if (Math.abs(c.t - t) < 60_000) return c.t <= t ? c : await tsAt(n - 1);
    a = b; b = c;
  }
  return b;
}
const gini = (xs: number[]) => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b), n = v.length, total = v.reduce((a, b) => a + b, 0);
  if (n < 2 || !total) return null;
  let cum = 0; for (let i = 0; i < n; i++) cum += (2 * (i + 1) - n - 1) * v[i];
  return cum / (n * total);
};
type Prev = { wallet: string; balance: number; rank: number }[];
function bandRows(day: string, ranked: [string, number][], prev: Prev, all: Map<string, number>) {
  const prevMap = new Map(prev.map((p) => [p.wallet, p])), today = new Set(ranked.map(([w]) => w));
  return BANDS.filter(([, lo]) => lo <= ranked.length).map(([band, lo, hi]) => {
    const now = ranked.slice(lo - 1, hi);
    let net: number | null = null, left: number | null = null;
    if (prev.length) {
      net = 0; left = 0;
      for (const p of prev) { if (p.rank < lo || p.rank > hi) continue; if (!today.has(p.wallet)) left++; net += (all.get(p.wallet) ?? 0) - p.balance; }
    }
    return { token: "DOT", day, band, balance: now.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null };
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
  const started = Date.now(), result: Record<string, unknown> = {};
  const st: any = await loadState("dot_hist");
  try {
    if (st.status === "written") return Response.json({ ok: true, result: { done: { days: st.written, at: st.at } } });
    if (!KEY) throw new Error("no ONFINALITY_API_KEY");
    if (!st.wallets) {
      const { data: first } = await db.from("holder_daily").select("day").eq("token", "DOT").order("day").limit(1);
      const { data: snap } = await db.from("holder_snapshot").select("wallet").eq("token", "DOT");
      if (!first?.length || !snap?.length) throw new Error("no live DOT snapshot yet");
      const days: string[] = [];
      for (let d = addDays(new Date().toISOString().slice(0, 10), -DAYS); d <= first[0].day; d = addDays(d, 1)) days.push(d);
      Object.assign(st, { status: "reading", firstLive: first[0].day, wallets: snap.map((r) => r.wallet).filter((w) => accountKey(w)), days, done: [] });
    }
    const keys = st.wallets.map((w: string) => accountKey(w)!);
    while (Date.now() - started < BUDGET_MS) {
      const day = st.days.find((d: string) => !st.done.includes(d));
      if (!day) break;
      const blk = await blockAt(Date.parse(day + "T01:00:00Z"), st.last);
      st.last = { n: blk.n, t: blk.t };
      const bal: Record<string, number> = {};
      for (let i = 0; i < keys.length; i += 100) {
        const part = keys.slice(i, i + 100);
        const res = await rpc("state_queryStorageAt", [part, blk.h]);
        const changes = res?.[0]?.changes;
        if (!Array.isArray(changes)) throw new Error(`no storage answer for ${day}`);
        const byKey = new Map(changes.map(([k, v]: [string, string | null]) => [k, v]));
        part.forEach((k: string, j: number) => { const v = byKey.get(k); bal[st.wallets[i + j]] = v ? dotTotal(v) : 0; });
        await sleep(400);
      }
      await saveState(`dot_hist_${day}`, { n: blk.n, t: blk.t, bal });
      st.done.push(day);
    }
    const left = st.days.filter((d: string) => !st.done.includes(d));
    if (left.length) { result.progress = { done: st.done.length, left: left.length, next: left[0] }; return Response.json({ ok: true, result }); }

    // Every day read: bands and daily rows for the days before the first live day, net only for that day
    const kl = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=DOTUSDT&interval=1d&limit=${DAYS + 10}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => []);
    const priceOf = new Map((Array.isArray(kl) ? kl : []).map((k: any) => [new Date(+k[0]).toISOString().slice(0, 10), +k[1]]));
    const bandOut: any[] = [], dailyOut: any[] = [];
    let prev: Prev = [];
    for (const day of st.days) {
      const s: any = await loadState(`dot_hist_${day}`);
      const all = new Map<string, number>(Object.entries(s.bal ?? {}));
      const ranked = [...all].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, 1000);
      if (ranked.length < 10) { prev = []; continue; }
      const rows = bandRows(day, ranked, prev, all);
      if (day === st.firstLive) {
        for (const r of rows) await db.from("holder_bands").update({ net: r.net, left_top: r.left_top, entered: r.entered }).eq("token", "DOT").eq("day", day).eq("band", r.band).is("net", null);
      } else {
        bandOut.push(...rows);
        dailyOut.push({ token: "DOT", day, price: priceOf.get(day) ?? null, holders: null, top10_pct: null, top100_pct: null, gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: SOURCE, depth: ranked.length });
      }
      prev = ranked.map(([wallet, balance], i) => ({ wallet, balance, rank: i + 1 }));
    }
    for (let i = 0; i < bandOut.length; i += 500) { const { error } = await db.from("holder_bands").upsert(bandOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    for (let i = 0; i < dailyOut.length; i += 500) { const { error } = await db.from("holder_daily").upsert(dailyOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    Object.assign(st, { status: "written", written: dailyOut.length, at: new Date().toISOString() });
    result.written = { days: dailyOut.length, from: dailyOut[0]?.day, to: dailyOut[dailyOut.length - 1]?.day, wallets: st.wallets.length };
  } catch (e) {
    result.error = mask(String(e instanceof Error ? e.message : e)).slice(0, 200);
  } finally {
    await saveState("dot_hist", st);
    await saveState("dot_hist_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
  }
  return Response.json({ ok: !result.error, result });
});

// APT holder history (one-off backfill): the live APT snapshots (Aptos indexer) start on 2026-11-01, so the
// 180 days before are rebuilt from each followed wallet's own APT activity in the Aptos Labs indexer
// (fungible_asset_activities: deposits, withdrawals and gas fees, with their time; APTOS_API_KEY as Bearer):
// balance at a day's 01:00 UTC = today's balance − every change after it. Wallets with more than
// MAX_PAGES pages of activity in the window (busy exchange wallets) are left out. Same bands as the live
// snapshots. Limit (said on the page): only today's wallets are followed back in time; liquid APT only
// (staked APT is not in the balance), like the live snapshots.
// Called by pg_cron every 3 minutes until done; then it does nothing.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const KEY = (Deno.env.get("APTOS_API_KEY") ?? "").trim(), GQL = "https://api.mainnet.aptoslabs.com/v1/graphql";
const APT_TYPES = `["0x1::aptos_coin::AptosCoin", "0x000000000000000000000000000000000000000000000000000000000000000a"]`;
const DAYS = 180, MAX_PAGES = 40, BUDGET_MS = 80_000;
const BANDS: [string, number, number][] = [["1-10", 1, 10], ["11-50", 11, 50], ["51-100", 51, 100], ["101-500", 101, 500], ["501-1000", 501, 1000],
  ["1-100", 1, 100], ["101-200", 101, 200], ["201-300", 201, 300], ["301-400", 301, 400], ["401-500", 401, 500]];
const SOURCE = "aptos indexer (lịch sử dựng lại từ giao dịch của ví lớn hiện tại)";
const mask = (s: string) => KEY.length > 8 ? s.split(KEY).join("***") : s;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const loadState = async (key: string) => (await db.from("collector_state").select("value").eq("key", key).maybeSingle()).data?.value ?? {};
const saveState = (key: string, value: unknown) => db.from("collector_state").upsert({ key, value, updated_at: new Date().toISOString() });

async function gql(query: string) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(GQL, { method: "POST", headers: { "content-type": "application/json", ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}) },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(20000) }).catch(() => null);
    const j: any = r ? await r.json().catch(() => null) : null;
    if (r?.status === 200 && j?.data && !j.errors) return j.data;
    if (i === 2) throw new Error(mask(`aptos indexer ${r?.status ?? 0} ${JSON.stringify(j?.errors?.[0]?.message ?? j?.errors ?? "").slice(0, 120)}`));
    await sleep(2000 * (i + 1));
  }
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
    return { token: "APT", day, band, balance: now.reduce((s, [, b]) => s + b, 0), net, left_top: left, entered: prev.length ? now.filter(([w]) => !prevMap.has(w)).length : null };
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
  const st: any = await loadState("apt_hist");
  try {
    if (st.status === "written") return Response.json({ ok: true, result: { done: { days: st.written, at: st.at } } });
    if (!st.wallets) {
      const { data: first } = await db.from("holder_daily").select("day").eq("token", "APT").order("day").limit(1);
      const { data: snap } = await db.from("holder_snapshot").select("wallet").eq("token", "APT");
      if (!first?.length || !snap?.length) throw new Error("no live APT snapshot yet");
      const wallets: string[] = snap.map((r) => r.wallet);
      // Today's balances, read now (the activities after this moment are not counted)
      const now = new Date().toISOString().slice(0, 19), bal: Record<string, number> = {};
      for (let i = 0; i < wallets.length; i += 100) {
        const d = await gql(`{ current_fungible_asset_balances(where: {asset_type: {_eq: "0x1::aptos_coin::AptosCoin"}, owner_address: {_in: ${JSON.stringify(wallets.slice(i, i + 100))}}}) { owner_address amount } }`);
        for (const x of d.current_fungible_asset_balances) bal[x.owner_address] = Number(x.amount) / 1e8;
        for (const w of wallets.slice(i, i + 100)) bal[w] ??= 0;
      }
      const days: string[] = [];
      for (let d = addDays(new Date().toISOString().slice(0, 10), -DAYS); d <= first[0].day; d = addDays(d, 1)) days.push(d);
      Object.assign(st, { status: "reading", firstLive: first[0].day, wallets, now, bal, days, queue: [...wallets], data: {}, cur: null });
    }
    const since = st.days[0] + "T01:00:00";
    // Read each wallet's activity in the window, newest first, 100 a page; progress is saved as it goes
    while ((st.cur || st.queue.length) && Date.now() - started < BUDGET_MS) {
      if (!st.cur) st.cur = { w: st.queue.shift(), offset: 0, pages: 0, deltas: {} };
      const c = st.cur;
      const d = await gql(`{ fungible_asset_activities(where: {owner_address: {_eq: "${c.w}"}, asset_type: {_in: ${APT_TYPES}}, is_transaction_success: {_eq: true}, transaction_timestamp: {_gte: "${since}", _lte: "${st.now}"}}, order_by: {transaction_version: desc}, limit: 100, offset: ${c.offset}) { type amount is_gas_fee transaction_timestamp } }`);
      const rows: any[] = d.fungible_asset_activities ?? [];
      for (const x of rows) {
        const amt = Number(x.amount) / 1e8, t = String(x.transaction_timestamp);
        const sign = x.is_gas_fee || /Withdraw/.test(x.type) ? -1 : /Deposit/.test(x.type) ? 1 : 0;
        if (!sign) continue;
        // the day whose 01:00 UTC boundary this change comes after
        const day = t.slice(11, 13) >= "01" ? t.slice(0, 10) : addDays(t.slice(0, 10), -1);
        c.deltas[day] = (c.deltas[day] ?? 0) + sign * amt;
      }
      c.offset += rows.length; c.pages++;
      if (rows.length < 100 || c.pages >= MAX_PAGES) {
        st.data[c.w] = rows.length < 100 ? c.deltas : { skipped: `more than ${MAX_PAGES * 100} APT movements in ${DAYS} days` };
        st.cur = null;
      }
      if (c.pages % 10 === 0) await saveState("apt_hist", st);
      await sleep(120);
    }
    if (st.cur || st.queue.length) {
      result.progress = { read: Object.keys(st.data).length, left: st.queue.length + (st.cur ? 1 : 0) };
      return Response.json({ ok: true, result });
    }
    // Every wallet read: balance at each day's 01:00 UTC = today's balance − changes after that boundary
    const kl = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=APTUSDT&interval=1d&limit=${DAYS + 10}`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => []);
    const priceOf = new Map((Array.isArray(kl) ? kl : []).map((k: any) => [new Date(+k[0]).toISOString().slice(0, 10), +k[1]]));
    const used = Object.entries(st.data as Record<string, any>).filter(([, v]) => !v.skipped);
    const bandOut: any[] = [], dailyOut: any[] = [];
    let prev: Prev = [];
    for (const day of st.days) {
      const all = new Map<string, number>();
      for (const [w, deltas] of used) {
        let b = st.bal[w] ?? 0;
        for (const [d, v] of Object.entries(deltas as Record<string, number>)) if (d >= day) b -= v;   // changes after this day's boundary
        all.set(w, Math.max(0, b));
      }
      const ranked = [...all].filter(([, b]) => b > 0).sort((a, b) => b[1] - a[1]).slice(0, 1000);
      if (ranked.length < 10) { prev = []; continue; }
      const rows = bandRows(day, ranked, prev, all);
      if (day === st.firstLive) {
        for (const r of rows) await db.from("holder_bands").update({ net: r.net, left_top: r.left_top, entered: r.entered }).eq("token", "APT").eq("day", day).eq("band", r.band).is("net", null);
      } else {
        bandOut.push(...rows);
        dailyOut.push({ token: "APT", day, price: priceOf.get(day) ?? null, holders: null, top10_pct: null, top100_pct: null, gini: gini(ranked.map(([, b]) => b)), excluded: 0, source: SOURCE, depth: ranked.length });
      }
      prev = ranked.map(([wallet, balance], i) => ({ wallet, balance, rank: i + 1 }));
    }
    for (let i = 0; i < bandOut.length; i += 500) { const { error } = await db.from("holder_bands").upsert(bandOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    for (let i = 0; i < dailyOut.length; i += 500) { const { error } = await db.from("holder_daily").upsert(dailyOut.slice(i, i + 500)); if (error) throw new Error(error.message); }
    const skipped = Object.values(st.data as Record<string, any>).filter((v) => v.skipped).length;
    Object.assign(st, { status: "written", written: dailyOut.length, skipped, at: new Date().toISOString(), data: {}, bal: {} });
    result.written = { days: dailyOut.length, from: dailyOut[0]?.day, to: dailyOut[dailyOut.length - 1]?.day, wallets: used.length, skipped };
  } catch (e) {
    result.error = mask(String(e instanceof Error ? e.message : e)).slice(0, 200);
  } finally {
    await saveState("apt_hist", st);
    await saveState("apt_hist_status", { at: new Date().toISOString(), ms: Date.now() - started, result });
  }
  return Response.json({ ok: !result.error, result });
});

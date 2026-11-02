// Weekly private backup: the tables that cannot be rebuilt from outside sources (holder history, the
// signal log, smart-money wallets and moves, whale trades, CryptoQuant metrics, labels, watchlist),
// each as gzipped NDJSON in the private Storage bucket "backups", one folder per run date. The last
// KEEP runs are kept. cex_volume is a short rolling buffer (a few days of minute data, pruned by the
// collector), so it is not backed up. Nothing here is public: the bucket has no public access and the
// function only runs for pg_cron (shared secret).
//
// A run that ends before every table is written continues on the next call (pg_cron calls twice):
// tables already in today's folder are skipped.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const BUCKET = "backups";
const KEEP = 8;              // weekly runs kept (about two months)
const PAGE = 1000;           // PostgREST rows per request
const BUDGET_MS = 110_000;   // the platform limit is 150 s
// table -> primary key (stable order for paging)
const TABLES: [string, string[]][] = [
  ["holder_daily", ["token", "day"]], ["holder_bands", ["token", "day", "band"]], ["holder_snapshot", ["token", "wallet"]],
  ["signal_log", ["day", "token"]], ["momentum_daily", ["token", "day"]],
  ["smart_wallets", ["chain", "address"]], ["smart_moves", ["id"]], ["whale_trades", ["id"]],
  ["cq_metrics", ["asset", "metric", "t"]], ["dex_volume", ["symbol", "minute"]],
  ["wallet_labels", ["key"]], ["watchlist", ["symbol"]],
];

async function gzip(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function dump(table: string, key: string[], deadline: number) {
  const lines: string[] = [];
  for (let from = 0; ; from += PAGE) {
    if (Date.now() > deadline) return null;   // finish on the next call
    let q = db.from(table).select("*");
    for (const k of key) q = q.order(k, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data ?? []) lines.push(JSON.stringify(r));
    if (!data || data.length < PAGE) break;
  }
  return lines;
}
async function fromCron(req: Request) {
  const s = req.headers.get("x-cron-secret") ?? "";
  if (s.length < 32) return false;
  const { data } = await db.rpc("cron_secret_ok", { p: s });
  return data === true;
}

Deno.serve(async (req) => {
  if (!(await fromCron(req))) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const started = Date.now(), deadline = started + BUDGET_MS;
  const day = new Date().toISOString().slice(0, 10);
  const store = db.storage.from(BUCKET);
  const { data: have } = await store.list(day, { limit: 100 });
  const done = new Set((have ?? []).map((f) => f.name));
  const result: Record<string, unknown> = {};
  let complete = true;
  for (const [table, key] of TABLES) {
    const name = `${table}.ndjson.gz`;
    if (done.has(name)) { result[table] = "already saved"; continue; }
    try {
      const lines = await dump(table, key, deadline);
      if (!lines) { complete = false; result[table] = "next call"; continue; }
      const body = await gzip(lines.join("\n") + "\n");
      const { error } = await store.upload(`${day}/${name}`, body, { contentType: "application/gzip", upsert: true });
      if (error) throw new Error(error.message);
      result[table] = { rows: lines.length, kb: Math.round(body.length / 1024) };
    } catch (e) { complete = false; result[table] = { error: String((e as Error).message ?? e).slice(0, 200) }; }
  }
  // Once this run is complete, keep only the newest KEEP run folders
  const removed: string[] = [];
  if (complete) {
    const { data: root } = await store.list("", { limit: 1000, sortBy: { column: "name", order: "desc" } });
    const runs = (root ?? []).map((f) => f.name).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
    for (const old of runs.slice(KEEP)) {
      const { data: files } = await store.list(old, { limit: 100 });
      if (files?.length) await store.remove(files.map((f) => `${old}/${f.name}`));
      removed.push(old);
    }
  }
  const status = { at: new Date().toISOString(), day, complete, ms: Date.now() - started, result, removed };
  await db.from("collector_state").upsert({ key: "backup_status", value: status, updated_at: new Date().toISOString() });
  return Response.json({ ok: true, ...status });
});

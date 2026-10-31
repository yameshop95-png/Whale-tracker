// Add or remove a manually followed smart-money wallet.
// POST { token, action: "add" | "remove", chain: "eth" | "sei" | "solana", address, label? }
// `token` must equal the WALLET_ADMIN_TOKEN secret; nobody else can change the list.
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const ADMIN = Deno.env.get("WALLET_ADMIN_TOKEN") ?? "";
const MAX_MANUAL = 50;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

// Constant-time comparison, so response timing doesn't leak how much of the token matched
function same(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return reply({ error: "invalid JSON" }, 400); }

  if (ADMIN.length < 12) return reply({ error: "WALLET_ADMIN_TOKEN chưa được cài (cần ít nhất 12 ký tự)" }, 503);
  if (typeof b?.token !== "string" || !same(b.token, ADMIN)) {
    await new Promise((r) => setTimeout(r, 800));   // slow down guessing
    return reply({ error: "Sai mật khẩu quản trị" }, 401);
  }
  const chain = b.chain;
  if (!["eth", "sei", "solana"].includes(chain)) return reply({ error: "chain phải là eth, sei hoặc solana" }, 400);
  let address = String(b.address ?? "").trim();
  if (chain === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return reply({ error: "Địa chỉ Solana không hợp lệ" }, 400);
  } else {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return reply({ error: "Địa chỉ EVM không hợp lệ" }, 400);
    address = address.toLowerCase();
  }

  if (b.action === "remove") {
    const { error } = await db.from("smart_wallets").delete().eq("chain", chain).eq("address", address);
    return error ? reply({ error: error.message }, 500) : reply({ ok: true, removed: `${chain}:${address}` });
  }
  if (b.action !== "add") return reply({ error: "action phải là add hoặc remove" }, 400);

  const { count } = await db.from("smart_wallets").select("*", { count: "exact", head: true }).eq("source", "manual");
  if ((count ?? 0) >= MAX_MANUAL) return reply({ error: `Đã đủ ${MAX_MANUAL} ví tự nhập` }, 409);
  const label = String(b.label ?? "").replace(/[<>]/g, "").trim().slice(0, 40) || null;
  // Manual wins over auto: adding a discovered wallet turns it into a manual one
  const { error } = await db.from("smart_wallets").upsert({ chain, address, label, source: "manual" });
  return error ? reply({ error: error.message }, 500) : reply({ ok: true, added: `${chain}:${address}` });
});

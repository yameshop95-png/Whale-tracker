-- Exchange wallets (labels from Blockscout / Open Labels Initiative) are tracked apart from real whales:
--   'cex'      = wallets labelled as an exchange, wherever they rank
--   'whale_ex' = Top 1-50 without exchange wallets
alter table public.holder_snapshot add column if not exists exchange text;
alter table public.holder_bands drop constraint if exists holder_bands_band_check;
alter table public.holder_bands add constraint holder_bands_band_check
  check (band = any (array['1-10', '11-50', '51-100', '101-500', '501-1000', 'cex', 'whale_ex']));

-- Labels looked up once and kept (re-checked after 30 days). Private: no policy for the website.
create table if not exists public.wallet_labels (
  key        text primary key,          -- "eth:0x…" (BNB Chain uses the Ethereum label) or "op:0x…"
  exchange   text,                      -- exchange name, or null when the address has no exchange label
  checked_at timestamptz not null default now()
);
alter table public.wallet_labels enable row level security;

create or replace function public.labels_for(keys text[]) returns table(key text, exchange text, checked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select l.key, l.exchange, l.checked_at from public.wallet_labels l where l.key = any(keys)
$$;
revoke all on function public.labels_for(text[]) from public, anon, authenticated;
grant execute on function public.labels_for(text[]) to service_role;

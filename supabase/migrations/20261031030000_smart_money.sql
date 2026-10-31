-- Smart money: wallets to follow and their token movements.
-- Wallet addresses and transfers are public on-chain data, so both tables are publicly readable.
-- Only the server writes: the 'smart' function (auto-discovered wallets, movements) and the
-- 'wallets' function (manual adds/removes, protected by the WALLET_ADMIN_TOKEN secret).

create table public.smart_wallets (
  chain     text not null check (chain in ('eth', 'sei', 'solana')),
  address   text not null,
  label     text,
  source    text not null check (source in ('manual', 'auto')),
  meta      jsonb not null default '{}'::jsonb,   -- auto: what got it noticed (coin, dex, usd)
  added_at  timestamptz not null default now(),
  last_move timestamptz,
  primary key (chain, address)
);

create table public.smart_moves (
  id           text primary key,                  -- chain:tx:index
  chain        text not null,
  address      text not null,
  time         timestamptz not null,
  direction    text not null check (direction in ('in', 'out')),
  token        text not null,                     -- symbol of a verified token or the native coin
  amount       double precision not null,
  usd          double precision,
  counterparty text,
  cp_label     text,                              -- e.g. an exchange name when known
  tx_hash      text not null
);
create index smart_moves_time_idx on public.smart_moves (time desc);
create index smart_moves_addr_idx on public.smart_moves (chain, address, time desc);

alter table public.smart_wallets enable row level security;
alter table public.smart_moves   enable row level security;
create policy "public read" on public.smart_wallets for select to anon, authenticated using (true);
create policy "public read" on public.smart_moves   for select to anon, authenticated using (true);

-- Retention: movements like the other per-minute data; auto wallets that went quiet are pruned
create or replace function public.cleanup_old() returns void
language sql set search_path = '' as $$
  delete from public.cex_volume   where minute < now() - interval '8 days';
  delete from public.dex_volume   where minute < now() - interval '8 days';
  delete from public.whale_trades where time   < now() - interval '8 days';
  delete from public.cq_metrics   where t      < now() - interval '120 days';
  delete from public.smart_moves  where time   < now() - interval '8 days';
  delete from public.smart_wallets where source = 'auto'
    and coalesce(last_move, added_at) < now() - interval '14 days';
$$;
revoke execute on function public.cleanup_old() from public, anon, authenticated;

-- The website shows the smart-money run status too (counts and key-scrubbed errors, no secrets)
drop policy "public status" on public.collector_state;
create policy "public status" on public.collector_state for select to anon, authenticated
  using (key in ('status', 'smart_status'));

-- Run the 'smart' function every 5 minutes, offset from the minute mark so it doesn't
-- start together with 'collect' (both use the Etherscan free tier)
select cron.schedule(
  'whale-smart',
  '2-59/5 * * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/smart',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

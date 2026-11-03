-- BTC whale pool: addresses found moving ≥ 100 BTC in a block, with their last balance (see the btc
-- function). Private: no read policy; the web reads BTC through holder_bands / holder_daily like any coin.
create table if not exists public.btc_whale_pool (
  address text primary key,
  balance double precision,
  checked_at timestamptz,
  first_seen timestamptz not null default now(),
  seen_btc double precision
);
alter table public.btc_whale_pool enable row level security;
create index if not exists btc_whale_pool_balance on public.btc_whale_pool (balance desc);

-- Every 10 minutes: discovery all day, the daily snapshot once the UTC day has started
select cron.schedule('whale-btc', '3-59/10 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/btc', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

-- ADA whale pool from Blockfrost pool delegators (see the ada function). Private: no read policy.
create table if not exists public.ada_whale_pool (
  stake text primary key,
  live_stake double precision,
  seen_at timestamptz
);
alter table public.ada_whale_pool enable row level security;
create index if not exists ada_whale_pool_stake on public.ada_whale_pool (live_stake desc);
-- Every 10 minutes: the delegator scan until done (then weekly), the daily snapshot after 00:07 UTC
select cron.schedule('whale-ada', '6-59/10 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/ada', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

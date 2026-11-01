-- Holder bands for the radar's top 120 coins: record where each day's list came from and how deep it
-- is (the page names the source and says when only the top 100 was available).
alter table public.holder_daily add column if not exists source text;
alter table public.holder_daily add column if not exists depth integer;

-- More coins need more calls: every 5 minutes from 00:07 to 04:57 UTC (11:07–15:57 Sydney summer).
select cron.schedule(
  'whale-holders',
  '7-59/5 0-4 * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/holders',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

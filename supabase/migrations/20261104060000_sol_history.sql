-- Solana tokens' holder history backfill (function solhist): every 3 minutes until every token is written,
-- then the calls do nothing (unschedule with select cron.unschedule('whale-solhist'))
select cron.schedule('whale-solhist', '1-59/3 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/solhist', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

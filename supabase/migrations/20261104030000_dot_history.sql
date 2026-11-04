-- DOT holder history backfill (function dothist): every 6 minutes (minutes 0, 6, …: never at the same time as evmhold, both use OnFinality) until the 180 days are written, then the
-- calls do nothing (unschedule with select cron.unschedule('whale-dothist'))
select cron.schedule('whale-dothist', '0-59/6 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/dothist', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

-- DOT holder history backfill (function dothist): every 3 minutes until the 180 days are written, then the
-- calls do nothing (unschedule with select cron.unschedule('whale-dothist'))
select cron.schedule('whale-dothist', '1-59/3 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/dothist', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

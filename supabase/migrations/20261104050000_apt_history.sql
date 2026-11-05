-- APT holder history backfill (function apthist): every 3 minutes until the 180 days are written, then the
-- calls do nothing (unschedule with select cron.unschedule('whale-apthist'))
select cron.schedule('whale-apthist', '2-59/3 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/apthist', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

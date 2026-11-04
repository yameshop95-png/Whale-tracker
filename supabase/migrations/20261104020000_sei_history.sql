-- SEI holder history backfill (function seihist): every 3 minutes until it has written the ~27 days the
-- public Sei node still keeps, then the calls do nothing (unschedule with select cron.unschedule('whale-seihist'))
select cron.schedule('whale-seihist', '*/3 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/seihist', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

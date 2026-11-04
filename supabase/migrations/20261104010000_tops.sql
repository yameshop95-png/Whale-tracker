-- Ranked lists for the home page, Holder Flow and Smart Bands (see the tops function): once an hour
-- while the daily holder snapshots come in
select cron.schedule('whale-tops', '55 1-9 * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/tops', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

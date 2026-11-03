-- HYPE holders (see the hype function): once a day after 01:00 UTC, retried hourly until the day is stored
select cron.schedule('whale-hype', '47 1-6 * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/hype', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

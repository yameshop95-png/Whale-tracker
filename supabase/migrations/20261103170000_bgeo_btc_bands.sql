-- BTC price bands from BGeometrics (see the bgeo function): once a day after their 03:00 UTC update,
-- retried at 05:23 in case the first call failed (the function skips when today's data is stored)
select cron.schedule('whale-bgeo', '23 3,5 * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/bgeo', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

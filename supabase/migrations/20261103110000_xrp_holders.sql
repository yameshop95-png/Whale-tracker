-- XRP holders from XRPSCAN (see the xrp function): once a day after 01:00 UTC, retried until done
select cron.schedule('whale-xrp', '17 1-6 * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/xrp', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

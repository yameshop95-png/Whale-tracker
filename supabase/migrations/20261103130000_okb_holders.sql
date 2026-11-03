-- OKB holders on X Layer (see the okb function): once a day after 01:00 UTC, retried until done
select cron.schedule('whale-okb', '27 1-6 * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/okb', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

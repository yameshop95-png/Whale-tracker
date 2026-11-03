-- DeFi data from DefiLlama (see the defi function): once an hour, stored in market_lists
select cron.schedule('whale-defi', '41 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/defi', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

-- ARB + AVAX Holder Flow (function evmhold): daily snapshot after 00:30 UTC and the 180-day history
select cron.schedule('whale-evmhold', '2-59/3 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/evmhold', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

-- 'holders' runs with a time budget per call: call it every 10 minutes from 00:07 to 01:57 UTC so
-- slow coins finish and the history rebuild advances. (Replaces the single daily call.)
select cron.schedule(
  'whale-holders',
  '7-59/10 0-1 * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/holders',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

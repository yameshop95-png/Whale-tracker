-- Second daily call of 'holders' 15 minutes after the first: tokens already snapshotted that day are
-- skipped, so it only finishes what the first run could not (time limit, a rate-limited API).
select cron.schedule(
  'whale-holders-retry',
  '22 0 * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/holders',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

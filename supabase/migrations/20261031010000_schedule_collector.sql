-- Run the collector Edge Function every minute. The function's own run lock
-- (try_start_run) makes overlapping or extra calls a no-op.
select cron.schedule(
  'whale-collect',
  '* * * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/collect',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

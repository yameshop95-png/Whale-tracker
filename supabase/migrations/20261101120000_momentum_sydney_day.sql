-- The radar scores Sydney days: run just after Sydney midnight. 13:20 UTC = 00:20 AEDT (summer),
-- 14:20 UTC = 00:20 AEST (winter); the call that comes before midnight finds the day already scored.
select cron.schedule(
  'whale-momentum',
  '20 13,14 * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/momentum',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

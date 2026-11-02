-- Weekly private backup (function "backup"): private Storage bucket and a pg_cron job on Sundays at
-- 16:30 UTC (Monday 03:30 Sydney summer time), called twice so a slow run finishes on the second call.
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do update set public = false;

select cron.schedule('whale-backup', '30,40 16 * * 0',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/backup', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

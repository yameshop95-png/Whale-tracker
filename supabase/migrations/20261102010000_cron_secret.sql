-- Only pg_cron may run the collector functions. A random shared secret lives in Supabase Vault (never
-- leaves the database): cron sends it in the x-cron-secret header, the functions check it with
-- cron_secret_ok(). The browser-facing functions (candles, wallets) stay as they are.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret', 'pg_cron -> edge functions')
where not exists (select 1 from vault.secrets where name = 'cron_secret');

create or replace function public.cron_secret_ok(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(length(p) >= 32 and exists (select 1 from vault.decrypted_secrets where name = 'cron_secret' and decrypted_secret = p), false)
$$;
revoke all on function public.cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.cron_secret_ok(text) to service_role;

create or replace function public.cron_headers() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'))
$$;
revoke all on function public.cron_headers() from public, anon, authenticated;

select cron.schedule('whale-collect', '* * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/collect', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);
select cron.schedule('whale-smart', '2-59/5 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/smart', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);
select cron.schedule('whale-holders', '7-59/5 0-4 * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/holders', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);
select cron.schedule('whale-momentum', '20 13,14 * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/momentum', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

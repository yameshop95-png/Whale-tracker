-- One public summary of every data source for the page's "Tình trạng dữ liệu" panel: times, counts,
-- names of the coins that failed. No keys, no raw error text beyond short scrubbed reasons.
create or replace function public.data_health() returns jsonb
language sql stable security definer set search_path = '' as $$
  with st as (select key, value, updated_at from public.collector_state
              where key in ('status', 'smart_status', 'holders_status', 'momentum_status', 'goldrush_usage', 'labels_todo', 'holder_universe')),
  hs as (select value from st where key = 'holders_status'),
  hres as (select r.key as token, r.value as v from hs, jsonb_each(hs.value->'result') r
           where r.key ~ '^[A-Z0-9]{2,12}$'),
  cron as (select j.jobname, d.status, d.start_time from cron.job j
           join lateral (select status, start_time from cron.job_run_details x where x.jobid = j.jobid order by start_time desc limit 1) d on true)
  select jsonb_build_object(
    'now', now(),
    'collect', (select jsonb_build_object('at', value->>'at', 'ms', (value->>'ms')::int,
        'errors', (select count(*) from jsonb_object_keys(coalesce(value->'errors', '{}'::jsonb))),
        'error_keys', (select coalesce(jsonb_agg(k), '[]'::jsonb) from (select jsonb_object_keys(coalesce(value->'errors', '{}'::jsonb)) k limit 8) q))
      from st where key = 'status'),
    'cex_last', (select max(minute) from public.cex_volume),
    'smart', (select jsonb_build_object('at', value->>'at', 'ms', (value->>'ms')::int,
        'errors', (select count(*) from jsonb_object_keys(coalesce(value->'errors', '{}'::jsonb))), 'tracked', value->'tracked')
      from st where key = 'smart_status'),
    'smart_last_move', (select max(time) from public.smart_moves),
    'holders', (select jsonb_build_object('at', value->>'at', 'day', value->>'day',
        'failed', (select coalesce(jsonb_agg(jsonb_build_object('token', token, 'why', left(coalesce(v->>'error', v #>> '{}'), 60)) order by token), '[]'::jsonb)
                   from hres where jsonb_typeof(v) = 'string' or v ? 'error'),
        'credits', value->'goldrush_credits') from hs),
    'holders_today', (select count(*) from public.holder_daily where day = (now() at time zone 'utc')::date),
    'holders_expected', (select 15 + coalesce(jsonb_array_length(value->'tokens'), 0) from st where key = 'holder_universe'),
    'holder_sources', (select coalesce(jsonb_object_agg(src, last_day), '{}'::jsonb) from
        (select coalesce(source, 'khác') src, max(day) last_day from public.holder_daily where day > (now() at time zone 'utc')::date - 14 group by 1) q),
    'labels_waiting', (select jsonb_array_length(value) from st where key = 'labels_todo'),
    'labels_known', (select count(*) from public.wallet_labels),
    'exchanges_known', (select count(*) from public.wallet_labels where exchange is not null),
    'momentum', (select jsonb_build_object('at', value->>'at', 'day', value->>'day', 'coins', value->'coins',
        'failed', value->'failed') from st where key = 'momentum_status'),
    'cron', (select jsonb_object_agg(jobname, jsonb_build_object('status', status, 'at', start_time)) from cron),
    'db_mb', (select round(pg_database_size(current_database()) / 1048576.0))
  )
$$;
revoke all on function public.data_health() from public;
grant execute on function public.data_health() to anon, authenticated;

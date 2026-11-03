-- Confluence ("tín hiệu hội tụ") and the signal check page.
-- 1. signal_log gets the extra inputs of the confluence: smart-money net flow over 3 days, the volume
--    surge (3 days vs 30) and the 7-day taker-buy share, and the number of signals that agree.
-- 2. log_signals() fills them; existing rows are filled in place.
-- 3. signal_outcomes gets the new columns (appended, the view keeps its old columns).
-- 4. Two read-only functions for the web: today's confluence list and the aggregated outcome stats.
--    The raw signal_log stays private.

alter table public.signal_log add column if not exists shark_net_3d double precision;
alter table public.signal_log add column if not exists surge double precision;
alter table public.signal_log add column if not exists buy7 double precision;
alter table public.signal_log add column if not exists confluence smallint;

-- Smart-money wallets' net USD for a token over the 3 UTC days ending on d (in = received, out = sent)
create or replace function public.shark_net(p_token text, d date)
returns double precision language sql stable security definer set search_path = public as $$
  select sum(case when direction = 'in' then usd else -usd end)
  from smart_moves where token = p_token and time >= (d - 2)::timestamptz and time < (d + 1)::timestamptz and usd > 0
$$;

-- The 4 signals: whales adding over 3 days, smart money net in over 3 days, volume up with buyers in
-- control (3-day volume ≥ 1.5× the 30-day, taker buy share over 7 days > 50%), Gem Radar state
-- "Khởi động" or "Tích luỹ"
create or replace function public.confluence_count(whale double precision, shark double precision, surge double precision, buy7 double precision, state text)
returns smallint language sql immutable as $$
  select ((coalesce(whale, 0) > 0)::int + (coalesce(shark, 0) > 0)::int
        + (coalesce(surge, 0) >= 1.5 and coalesce(buy7, 0) > 0.5)::int + (coalesce(state, '') in ('launch', 'accum'))::int)::smallint
$$;

create or replace function public.log_signals(p_day date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare d date; n int;
begin
  d := coalesce(p_day, (select max(m.day) from momentum_daily m where exists (select 1 from holder_bands b where b.day = m.day and b.net is not null)));
  if d is null then return 0; end if;
  insert into signal_log (day, token, whale_src, whale_pct_1d, whale_pct_3d, cex_pct_1d, state, bull, accum, risk, heat, sust, price, depth, source,
                          shark_net_3d, surge, buy7)
  select d, t.token, w.src,
         case when w.src = 'whale_ex' then flow_pct(t.token, d, '{whale_ex}') else flow_pct(t.token, d, '{1-10,11-50}') end,
         (select sum(x) from (select case when w.src = 'whale_ex' then flow_pct(t.token, d - k, '{whale_ex}') else flow_pct(t.token, d - k, '{1-10,11-50}') end x
                              from generate_series(0, 2) k) s having count(x) = 3),
         flow_pct(t.token, d, '{cex}'),
         m.state, m.bull, m.accum, m.risk, m.heat, m.sust, m.price, hd.depth, hd.source,
         shark_net(t.token, d), (m.parts->>'surge')::double precision, (m.parts->>'buy7')::double precision
  from (select distinct token from holder_bands where day = d and net is not null) t
  cross join lateral (select case when exists (select 1 from holder_bands where token = t.token and day = d and band = 'whale_ex' and net is not null)
                                  then 'whale_ex' else 'top50' end src) w
  left join momentum_daily m on m.token = t.token and m.day = d
  left join holder_daily hd on hd.token = t.token and hd.day = d
  on conflict (day, token) do nothing;
  get diagnostics n = row_count;
  update signal_log set confluence = confluence_count(whale_pct_3d, shark_net_3d, surge, buy7, state) where day = d and confluence is null;
  return n;
end $$;

-- Existing rows: fill the new inputs in place (nothing removed)
update public.signal_log s set
  shark_net_3d = public.shark_net(s.token, s.day),
  surge = (select (m.parts->>'surge')::double precision from public.momentum_daily m where m.token = s.token and m.day = s.day),
  buy7 = (select (m.parts->>'buy7')::double precision from public.momentum_daily m where m.token = s.token and m.day = s.day)
where s.surge is null;
update public.signal_log set confluence = public.confluence_count(whale_pct_3d, shark_net_3d, surge, buy7, state) where confluence is null;

-- New columns appended at the end of the view (its existing columns keep their order)
create or replace view public.signal_outcomes as
select s.day, s.token, s.whale_src, s.whale_pct_1d, s.whale_pct_3d, s.cex_pct_1d, s.state, s.bull, s.accum, s.risk, s.heat, s.sust,
  s.price, s.depth, s.source, s.logged_at,
  case
    when s.whale_pct_3d > 0 and s.state = any (array['accum', 'trend', 'launch', 'expand']) then 'gom_da'
    when s.whale_pct_3d > 0 and s.state = 'weak' then 'gom_yeu'
    when s.whale_pct_3d < 0 and s.state = any (array['hot', 'expand', 'trend']) then 'xa_nong'
    when s.whale_pct_3d < 0 and s.state = 'weak' then 'xa_yeu'
    else 'khac'
  end as kind,
  (select 100 * (m.price / s.price - 1) from public.momentum_daily m where m.token = s.token and m.day = s.day + 3) as ret_3d,
  (select 100 * (m.price / s.price - 1) from public.momentum_daily m where m.token = s.token and m.day = s.day + 7) as ret_7d,
  (select 100 * (m.price / s.price - 1) from public.momentum_daily m where m.token = s.token and m.day = s.day + 14) as ret_14d,
  s.shark_net_3d, s.surge, s.buy7, s.confluence
from public.signal_log s;

-- Today's confluence list (latest logged day) for the home page
create or replace function public.confluence_latest()
returns table (day date, token text, name text, image text, price double precision, state text, bull double precision,
               whale boolean, shark boolean, vol boolean, gem boolean, confluence smallint,
               whale_pct_3d double precision, shark_net_3d double precision, surge double precision, buy7 double precision)
language sql stable security definer set search_path = public as $$
  select s.day, s.token, m.name, m.image, s.price, s.state, s.bull,
    coalesce(s.whale_pct_3d, 0) > 0, coalesce(s.shark_net_3d, 0) > 0, coalesce(s.surge, 0) >= 1.5 and coalesce(s.buy7, 0) > 0.5,
    coalesce(s.state, '') in ('launch', 'accum'), s.confluence, s.whale_pct_3d, s.shark_net_3d, s.surge, s.buy7
  from signal_log s left join momentum_daily m on m.token = s.token and m.day = s.day
  where s.day = (select max(day) from signal_log)
  order by s.confluence desc nulls last, s.bull desc nulls last
$$;

-- Outcome statistics per signal type, against the average of every logged coin on the same days
create or replace function public.signal_stats()
returns jsonb language sql stable security definer set search_path = public as $$
  with o as (select * from signal_outcomes),
  t(key, label, pick) as (values
    ('hoi_tu', 'Hội tụ ≥3 tín hiệu', 'c'), ('whale', '🐋 Cá voi gom 3 ngày', 'w'), ('shark', '🦈 Cá mập nhận vào ròng', 's'),
    ('vol', 'Volume tăng, phe mua áp đảo', 'v'), ('gem', 'Gem: Khởi động / Tích luỹ', 'g'),
    ('gom_da', 'Cá voi gom + xu hướng tốt', 'k1'), ('xa_nong', 'Cá voi xả khi đang nóng', 'k3'), ('all', 'Tất cả coin (mốc so sánh)', 'a')),
  x as (
    select t.key, t.label, o.* from t join o on case t.pick
      when 'c' then coalesce(o.confluence, 0) >= 3 when 'w' then coalesce(o.whale_pct_3d, 0) > 0 when 's' then coalesce(o.shark_net_3d, 0) > 0
      when 'v' then coalesce(o.surge, 0) >= 1.5 and coalesce(o.buy7, 0) > 0.5 when 'g' then coalesce(o.state, '') in ('launch', 'accum')
      when 'k1' then o.kind = 'gom_da' when 'k3' then o.kind = 'xa_nong' else true end)
  select jsonb_build_object(
    'from', (select min(day) from signal_log), 'to', (select max(day) from signal_log), 'rows', (select count(*) from signal_log),
    'types', coalesce((select jsonb_agg(r order by r.ord) from (
      select t.key, t.label, (select array_position(array['hoi_tu','whale','shark','vol','gem','gom_da','xa_nong','all'], t.key)) ord,
        count(x.token) n,
        count(x.ret_3d) n3, round(avg(x.ret_3d)::numeric, 2) avg3, round(100.0 * avg((x.ret_3d > 0)::int)::numeric, 1) up3,
        count(x.ret_7d) n7, round(avg(x.ret_7d)::numeric, 2) avg7, round(100.0 * avg((x.ret_7d > 0)::int)::numeric, 1) up7,
        count(x.ret_14d) n14, round(avg(x.ret_14d)::numeric, 2) avg14, round(100.0 * avg((x.ret_14d > 0)::int)::numeric, 1) up14
      from t left join x on x.key = t.key group by t.key, t.label) r), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(r) from (
      select day, token, confluence, state, round(ret_3d::numeric, 2) ret_3d, round(ret_7d::numeric, 2) ret_7d, round(ret_14d::numeric, 2) ret_14d
      from o where coalesce(confluence, 0) >= 3 order by day desc, confluence desc limit 40) r), '[]'::jsonb))
$$;

revoke all on function public.confluence_latest() from public;
revoke all on function public.signal_stats() from public;
grant execute on function public.confluence_latest() to anon, authenticated;
grant execute on function public.signal_stats() to anon, authenticated;
revoke all on function public.shark_net(text, date) from public, anon, authenticated;

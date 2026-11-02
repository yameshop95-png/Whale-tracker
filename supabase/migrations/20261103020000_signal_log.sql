-- Signal log: once a day, freeze what the page showed for every coin that has holder data — the big
-- holders' flow and the Momentum radar's state and scores, with the day's close. Rows are never
-- rewritten (a later change to the radar's scoring does not alter what was logged), so after a few
-- weeks signal_outcomes shows how each kind of signal played out 3, 7 and 14 days later.
--
-- Days: the radar scores Sydney days; the holder snapshot of date D is taken at 11:07 Sydney on D,
-- inside the same Sydney day, so both are matched on the same date.

create table if not exists public.signal_log (
  day date not null,
  token text not null,
  whale_src text not null,          -- 'whale_ex' (50 largest non-exchange wallets) or 'top50' (Top 1–50)
  whale_pct_1d real,                -- the group's net change that day, % of its balance the day before
  whale_pct_3d real,                -- sum of the last three days' % (null when a day is missing)
  cex_pct_1d real,                  -- exchange wallets' net change that day, % (EVM coins with labels)
  state text,                       -- radar state that day
  bull real, accum real, risk real, heat real, sust real,
  price double precision,           -- the day's close (radar, Binance spot)
  depth int,                        -- wallets in the holder list (reliability)
  source text,
  logged_at timestamptz not null default now(),
  primary key (day, token)
);
alter table public.signal_log enable row level security;   -- no policy: read through the view below

-- Group flow of one day as a % of the group's balance the day before
create or replace function public.flow_pct(p_token text, p_day date, p_bands text[])
returns real language sql stable as $$
  select case when sum(balance - net) > 0 then (100 * sum(net) / sum(balance - net))::real end
  from public.holder_bands
  where token = p_token and day = p_day and band = any(p_bands) and net is not null
$$;

create or replace function public.log_signals(p_day date default null)
returns int language plpgsql security definer set search_path = public as $$
declare d date; n int;
begin
  -- The latest day that has both radar scores and holder flow
  d := coalesce(p_day, (select max(m.day) from momentum_daily m where exists (select 1 from holder_bands b where b.day = m.day and b.net is not null)));
  if d is null then return 0; end if;
  insert into signal_log (day, token, whale_src, whale_pct_1d, whale_pct_3d, cex_pct_1d, state, bull, accum, risk, heat, sust, price, depth, source)
  select d, t.token, w.src,
         case when w.src = 'whale_ex' then flow_pct(t.token, d, '{whale_ex}') else flow_pct(t.token, d, '{1-10,11-50}') end,
         (select sum(x) from (select case when w.src = 'whale_ex' then flow_pct(t.token, d - k, '{whale_ex}') else flow_pct(t.token, d - k, '{1-10,11-50}') end x
                              from generate_series(0, 2) k) s having count(x) = 3),
         flow_pct(t.token, d, '{cex}'),
         m.state, m.bull, m.accum, m.risk, m.heat, m.sust, m.price, hd.depth, hd.source
  from (select distinct token from holder_bands where day = d and net is not null) t
  cross join lateral (select case when exists (select 1 from holder_bands where token = t.token and day = d and band = 'whale_ex' and net is not null)
                                  then 'whale_ex' else 'top50' end src) w
  left join momentum_daily m on m.token = t.token and m.day = d
  left join holder_daily hd on hd.token = t.token and hd.day = d
  on conflict (day, token) do nothing;   -- frozen: the first log of a day stays
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.log_signals(date) from public, anon, authenticated;
grant execute on function public.log_signals(date) to service_role;

-- Each logged day with its signal kind and the price move 3, 7 and 14 days later (null until known).
-- Kinds (this project's own rules):
--   gom_da      whales added over 3 days and the radar shows building strength (accum, trend, launch, expand)
--   gom_yeu     whales added over 3 days while the radar says weak (buying into weakness)
--   xa_nong     whales cut over 3 days while the radar shows hot / extended strength (hot, expand, trend)
--   xa_yeu      whales cut over 3 days and the radar says weak
--   khac        everything else (the baseline the kinds are compared with)
create or replace view public.signal_outcomes with (security_invoker = on) as
select s.*,
  case
    when s.whale_pct_3d > 0 and s.state in ('accum', 'trend', 'launch', 'expand') then 'gom_da'
    when s.whale_pct_3d > 0 and s.state = 'weak' then 'gom_yeu'
    when s.whale_pct_3d < 0 and s.state in ('hot', 'expand', 'trend') then 'xa_nong'
    when s.whale_pct_3d < 0 and s.state = 'weak' then 'xa_yeu'
    else 'khac' end as kind,
  (select 100 * (m.price / s.price - 1) from momentum_daily m where m.token = s.token and m.day = s.day + 3) as ret_3d,
  (select 100 * (m.price / s.price - 1) from momentum_daily m where m.token = s.token and m.day = s.day + 7) as ret_7d,
  (select 100 * (m.price / s.price - 1) from momentum_daily m where m.token = s.token and m.day = s.day + 14) as ret_14d
from public.signal_log s;
revoke all on public.signal_outcomes from anon, authenticated;

-- Daily after the radar (13:20 / 14:20 UTC); the second run is a no-op unless the first found nothing
select cron.schedule('whale-signal-log', '45 13,14 * * *', $$select public.log_signals()$$);

-- The days already available
select public.log_signals('2026-11-01');
select public.log_signals('2026-11-02');

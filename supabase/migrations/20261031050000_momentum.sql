-- Momentum radar: daily 0-100 scores and a state per coin (function 'momentum'), public read.
create table public.momentum_daily (
  token  text not null,
  day    date not null,                -- UTC day of the closed daily candle that was scored
  rank   int,                          -- market-cap rank among the scored coins (stablecoins left out)
  name   text,
  image  text,
  price  double precision,
  chg    double precision,             -- close vs previous close
  vol    double precision,             -- Binance quote volume that day (USDT)
  mcap   double precision,             -- latest day only
  bull   real, accum real, risk real, heat real, sust real,
  state  text,
  parts  jsonb,                        -- raw inputs of the scores, latest day only
  primary key (token, day)
);
create index momentum_daily_day_idx on public.momentum_daily (day);
alter table public.momentum_daily enable row level security;
create policy "public read" on public.momentum_daily for select to anon, authenticated using (true);

-- Daily, after the UTC candle closes
select cron.schedule(
  'whale-momentum',
  '20 0 * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/momentum',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

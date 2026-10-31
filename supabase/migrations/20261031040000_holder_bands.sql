-- Holder bands: daily snapshot of the largest holders of Solana tokens (Solana Tracker API),
-- grouped by rank. Only per-band totals are kept long term; the per-wallet snapshot keeps just
-- the latest day (it is what the next day is compared with) and is not public.

create table public.holder_daily (
  token        text not null,                -- coin symbol, e.g. PYTH
  day          date not null,                -- UTC day of the snapshot
  price        double precision,             -- USD price at snapshot time
  holders      bigint,                       -- total holder count reported by the API
  top10_pct    double precision,             -- % of supply held by the 10 largest wallets (pools excluded)
  top100_pct   double precision,
  gini         double precision,             -- Gini of the top-1000 balances (0 = equal, 1 = one wallet)
  excluded     int,                          -- program-owned (pool/vault) wallets left out
  primary key (token, day)
);

create table public.holder_bands (
  token    text not null,
  day      date not null,
  band     text not null check (band in ('1-10', '11-50', '51-100', '101-500', '501-1000')),
  balance  double precision not null,        -- tokens held by the band's wallets at this snapshot
  net      double precision,                 -- change of YESTERDAY's band wallets since yesterday (null on the first day)
  left_top int,                              -- of those, wallets no longer in the top 1000 (counted at the cut-off balance)
  entered  int,                              -- wallets in today's band that were not in yesterday's top 1000
  primary key (token, day, band)
);

create table public.holder_snapshot (
  token   text not null,
  wallet  text not null,
  balance double precision not null,
  rank    int not null,
  day     date not null,
  primary key (token, wallet)
);

alter table public.holder_daily    enable row level security;
alter table public.holder_bands    enable row level security;
alter table public.holder_snapshot enable row level security;   -- no policy: server only
create policy "public read" on public.holder_daily for select to anon, authenticated using (true);
create policy "public read" on public.holder_bands for select to anon, authenticated using (true);

-- Once a day, a few minutes after 00:00 UTC
select cron.schedule(
  'whale-holders',
  '7 0 * * *',
  $$select net.http_post(
      url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/holders',
      headers := '{"Content-Type":"application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 5000)$$
);

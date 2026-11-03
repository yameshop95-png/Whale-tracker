-- Bitcoin "profitable days": for each day, the share of all earlier trading days whose price was below
-- that day's price (buying on any of those days would be in profit then). Filled by the btc function
-- from Blockchain.com's official charts API (market-price, daily, since 2009). Public read.
create table if not exists public.btc_profitable_daily (
  day date primary key,
  price double precision not null,
  profitable_pct double precision
);
alter table public.btc_profitable_daily enable row level security;
create policy "public read" on public.btc_profitable_daily for select to anon, authenticated using (true);

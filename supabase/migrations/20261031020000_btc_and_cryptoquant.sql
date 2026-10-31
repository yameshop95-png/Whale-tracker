-- Track BTC 24/7 alongside SEI and ETH
insert into public.watchlist (symbol, pinned) values ('BTC', true)
  on conflict (symbol) do update set pinned = true;

-- CryptoQuant metrics, written by the collector when the CRYPTOQUANT_API_KEY secret is set.
-- Row level security is on with NO public read policy, so the data stays private until
-- you have confirmed CryptoQuant's terms allow showing it on a public website. To publish it:
--   create policy "public read" on public.cq_metrics for select to anon, authenticated using (true);
create table public.cq_metrics (
  asset  text not null,
  metric text not null,
  t      timestamptz not null,
  value  double precision not null,
  primary key (asset, metric, t)
);
alter table public.cq_metrics enable row level security;

-- Keep CryptoQuant's daily series longer than the per-minute exchange data
create or replace function public.cleanup_old() returns void
language sql set search_path = '' as $$
  delete from public.cex_volume   where minute < now() - interval '8 days';
  delete from public.dex_volume   where minute < now() - interval '8 days';
  delete from public.whale_trades where time   < now() - interval '8 days';
  delete from public.cq_metrics   where t      < now() - interval '120 days';
$$;
revoke execute on function public.cleanup_old() from public, anon, authenticated;

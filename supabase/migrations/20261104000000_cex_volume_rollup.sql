-- Keep the database well under the free plan's 500 MB: minute rows of cex_volume stay 5 days; rows 5 to 8
-- days old are merged into one row per 5 minutes (at the 5-minute mark, sums kept), then dropped after
-- 8 days as before. Every chart bucket is a multiple of 5 minutes (5 min, 1 h, 6 h), so the charts and
-- get_volume give the same totals; only a 1-minute view of data older than 5 days would show 5-minute rows.
create or replace function public.cleanup_old() returns void
language sql set search_path = '' as $$
  with moved as (
    delete from public.cex_volume
    where minute < now() - interval '5 days' and minute >= now() - interval '8 days'
      and (extract(minute from minute)::int % 5 <> 0 or extract(second from minute) <> 0)
    returning symbol, exchange, minute, buy_base, sell_base, buy_usd, sell_usd, trades, partial
  )
  insert into public.cex_volume (symbol, exchange, minute, buy_base, sell_base, buy_usd, sell_usd, trades, partial)
  select symbol, exchange,
         date_trunc('hour', minute) + floor(extract(minute from minute) / 5) * interval '5 minutes',
         sum(buy_base), sum(sell_base), sum(buy_usd), sum(sell_usd), sum(trades), bool_or(partial)
  from moved group by 1, 2, 3
  on conflict (symbol, exchange, minute) do update set
    buy_base = cex_volume.buy_base + excluded.buy_base, sell_base = cex_volume.sell_base + excluded.sell_base,
    buy_usd = cex_volume.buy_usd + excluded.buy_usd, sell_usd = cex_volume.sell_usd + excluded.sell_usd,
    trades = coalesce(cex_volume.trades, 0) + coalesce(excluded.trades, 0), partial = cex_volume.partial or excluded.partial;
  delete from public.cex_volume   where minute < now() - interval '8 days';
  delete from public.dex_volume   where minute < now() - interval '8 days';
  delete from public.whale_trades where time   < now() - interval '8 days';
  delete from public.cq_metrics   where t      < now() - interval '120 days';
  delete from public.smart_moves  where time   < now() - interval '8 days';
  delete from public.smart_wallets where source = 'auto'
    and coalesce(last_move, added_at) < now() - interval '14 days';
$$;
revoke execute on function public.cleanup_old() from public, anon, authenticated;

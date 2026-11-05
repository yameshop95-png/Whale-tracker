-- DRAFT — NOT applied by any migration runner. Review, then run manually in the Supabase SQL editor.
-- Problem: get_volume (anon, via PostgREST) sometimes fails with 57014 "canceling statement due to
-- statement timeout" (HTTP 500). The only indexes on cex_volume are PK (symbol, exchange, minute) and
-- (minute); a filter on symbol + minute range across all exchanges can't use either well, so a cold
-- cache scan of a 5-day 1-minute window exceeds the anon role's short statement_timeout.

-- 1) Index matching the query (symbol =, minute >=), covering the summed columns.
create index concurrently if not exists cex_volume_symbol_minute_idx
  on public.cex_volume (symbol, minute)
  include (exchange, buy_base, sell_base, buy_usd, sell_usd, trades, partial);

-- 2) Optional, only if 1) is not enough: give the website role a little more headroom (default 3s).
-- alter role anon set statement_timeout = '8s';
-- notify pgrst, 'reload config';

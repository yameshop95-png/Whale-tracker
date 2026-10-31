-- Whale Tracker storage. The collector Edge Function writes with the service role;
-- the website reads with the public anon key (read-only, plus adding coins to the watchlist).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Coins collected 24/7. Pinned ones can't be auto-removed.
create table public.watchlist (
  symbol   text primary key check (symbol ~ '^[A-Z0-9]{2,12}$'),
  pinned   boolean not null default false,
  added_at timestamptz not null default now()
);

create function public.watchlist_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.watchlist) >= 20 then
    raise exception 'Watchlist is full (max 20 coins)';
  end if;
  return new;
end $$;
create trigger watchlist_cap before insert on public.watchlist
  for each row execute function public.watchlist_cap();

insert into public.watchlist (symbol, pinned) values ('SEI', true), ('ETH', true);

-- CEX taker buy/sell volume per minute (OKX, Bybit, Upbit; Binance is read live from its klines).
-- partial = the exchange's recent-trades window may have missed some trades in that minute.
create table public.cex_volume (
  symbol    text not null,
  exchange  text not null,
  minute    timestamptz not null,
  buy_base  double precision not null default 0,
  sell_base double precision not null default 0,
  buy_usd   double precision not null default 0,
  sell_usd  double precision not null default 0,
  trades    integer not null default 0,
  partial   boolean not null default false,
  primary key (symbol, exchange, minute)
);
create index cex_volume_minute_idx on public.cex_volume (minute);

-- All on-chain DEX trades per minute (base units), used for the whale vs retail split.
create table public.dex_volume (
  symbol text not null,
  minute timestamptz not null,
  buy    double precision not null default 0,
  sell   double precision not null default 0,
  n      integer not null default 0,
  primary key (symbol, minute)
);
create index dex_volume_minute_idx on public.dex_volume (minute);

-- Individual large on-chain trades/transfers.
-- kind: buy | sell (DEX) or in | out | internal | wallet (exchange flow)
create table public.whale_trades (
  id           text primary key,
  symbol       text not null,
  time         timestamptz not null,
  kind         text not null,
  asset        text not null,
  amount       double precision not null,
  usd          double precision not null default 0,
  wallet       text,
  counterparty text,
  exchange     text,
  tx_hash      text not null
);
create index whale_trades_symbol_time_idx on public.whale_trades (symbol, time desc);

-- Collector cursors, run lock and last status (no secrets stored here).
create table public.collector_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- Row level security ----------
alter table public.watchlist       enable row level security;
alter table public.cex_volume      enable row level security;
alter table public.dex_volume      enable row level security;
alter table public.whale_trades    enable row level security;
alter table public.collector_state enable row level security;

create policy "public read" on public.watchlist    for select to anon, authenticated using (true);
create policy "public add"  on public.watchlist    for insert to anon, authenticated with check (pinned = false);
create policy "public read" on public.cex_volume   for select to anon, authenticated using (true);
create policy "public read" on public.dex_volume   for select to anon, authenticated using (true);
create policy "public read" on public.whale_trades for select to anon, authenticated using (true);
-- Only the status row is public; cursors and the lock stay private.
create policy "public status" on public.collector_state for select to anon, authenticated using (key = 'status');

-- ---------- Collector helpers (service role only) ----------
create function public.add_cex_trades(rows jsonb) returns void
language sql set search_path = '' as $$
  insert into public.cex_volume as c (symbol, exchange, minute, buy_base, sell_base, buy_usd, sell_usd, trades, partial)
  select r.symbol, r.exchange, r.minute, r.buy_base, r.sell_base, r.buy_usd, r.sell_usd, r.trades, r.partial
  from jsonb_to_recordset(rows) as r(symbol text, exchange text, minute timestamptz, buy_base float8, sell_base float8,
                                     buy_usd float8, sell_usd float8, trades int, partial bool)
  on conflict (symbol, exchange, minute) do update set
    buy_base  = c.buy_base  + excluded.buy_base,
    sell_base = c.sell_base + excluded.sell_base,
    buy_usd   = c.buy_usd   + excluded.buy_usd,
    sell_usd  = c.sell_usd  + excluded.sell_usd,
    trades    = c.trades    + excluded.trades,
    partial   = c.partial or excluded.partial;
$$;

create function public.add_dex_volume(rows jsonb) returns void
language sql set search_path = '' as $$
  insert into public.dex_volume as d (symbol, minute, buy, sell, n)
  select r.symbol, r.minute, r.buy, r.sell, r.n
  from jsonb_to_recordset(rows) as r(symbol text, minute timestamptz, buy float8, sell float8, n int)
  on conflict (symbol, minute) do update set
    buy = d.buy + excluded.buy, sell = d.sell + excluded.sell, n = d.n + excluded.n;
$$;

-- Returns true for at most one caller per min_seconds, so extra calls to the public
-- function URL can't make the collector hit the exchanges more often.
create function public.try_start_run(min_seconds int) returns boolean
language plpgsql set search_path = '' as $$
declare ok boolean;
begin
  insert into public.collector_state (key, updated_at) values ('run_lock', 'epoch')
    on conflict (key) do nothing;
  update public.collector_state set updated_at = now()
    where key = 'run_lock' and updated_at < now() - make_interval(secs => min_seconds)
    returning true into ok;
  return coalesce(ok, false);
end $$;

-- Keep a little over a week.
create function public.cleanup_old() returns void
language sql set search_path = '' as $$
  delete from public.cex_volume   where minute < now() - interval '8 days';
  delete from public.dex_volume   where minute < now() - interval '8 days';
  delete from public.whale_trades where time   < now() - interval '8 days';
$$;

revoke execute on function public.add_cex_trades(jsonb)  from public, anon, authenticated;
revoke execute on function public.add_dex_volume(jsonb)  from public, anon, authenticated;
revoke execute on function public.try_start_run(int)     from public, anon, authenticated;
revoke execute on function public.cleanup_old()          from public, anon, authenticated;
revoke execute on function public.watchlist_cap()        from public, anon, authenticated;

-- ---------- Read helpers for the website (RLS applies) ----------
create function public.get_volume(p_symbol text, p_from timestamptz, p_bucket_sec int)
returns table (exchange text, bucket timestamptz, buy_base float8, sell_base float8,
               buy_usd float8, sell_usd float8, trades bigint, partial boolean)
language sql stable set search_path = '' as $$
  select c.exchange,
         to_timestamp(floor(extract(epoch from c.minute) / p_bucket_sec) * p_bucket_sec),
         sum(c.buy_base), sum(c.sell_base), sum(c.buy_usd), sum(c.sell_usd), sum(c.trades), bool_or(c.partial)
  from public.cex_volume c
  where c.symbol = p_symbol and c.minute >= p_from
  group by 1, 2 order by 2;
$$;

create function public.get_dex_volume(p_symbol text, p_from timestamptz, p_bucket_sec int)
returns table (bucket timestamptz, buy float8, sell float8, n bigint)
language sql stable set search_path = '' as $$
  select to_timestamp(floor(extract(epoch from d.minute) / p_bucket_sec) * p_bucket_sec),
         sum(d.buy), sum(d.sell), sum(d.n)
  from public.dex_volume d
  where d.symbol = p_symbol and d.minute >= p_from
  group by 1 order by 1;
$$;

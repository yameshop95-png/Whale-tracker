-- Market data (function "market", every 15 minutes):
--   CoinMarketCap (owner's Basic key, CMC_API_KEY): global metrics, Fear & Greed, Altcoin Season,
--     CMC20/CMC100, top 200 prices and market caps, Real World Assets and Tokenized ETFs categories,
--     coin metadata. Credits are counted and capped below the plan's 15,000 a month.
--   Binance Alpha token list (Binance's public Alpha API) and CoinGecko's trending searches (public).
-- Pages read these tables; nothing here holds keys. The page shows "Nguồn: CoinMarketCap" etc.

create table if not exists public.market_global (
  ts timestamptz primary key,               -- time of the CoinMarketCap snapshot (hourly)
  total_mcap double precision, total_vol double precision, total_mcap_chg real,
  btc_dom real, eth_dom real, stable_mcap double precision, defi_mcap double precision, deriv_vol double precision,
  fear_greed smallint, fg_class text, altseason smallint,
  cmc20 double precision, cmc20_chg real, cmc100 double precision, cmc100_chg real
);
create table if not exists public.fear_greed_daily (
  day date primary key, value smallint not null, class text
);
create table if not exists public.market_lists (
  key text primary key,                     -- top200, rwa, tokenized_etf, alpha, trending, cmc20
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create table if not exists public.coin_meta (
  cmc_id int primary key,
  symbol text not null, name text, slug text, logo text, description text,
  website text, twitter text, explorer text, tags text[], category text, platform text,
  date_added date, updated_at timestamptz not null default now()
);
create index if not exists coin_meta_symbol on public.coin_meta (symbol);
create table if not exists public.alpha_seen (
  token_id text primary key, symbol text, first_seen timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['market_global', 'fear_greed_daily', 'market_lists', 'coin_meta', 'alpha_seen'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

select cron.schedule('whale-market', '4-59/15 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/market', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

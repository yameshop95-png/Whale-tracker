-- Spot crypto ETF flows from SoSoValue (owner's key, SOSOVALUE_API_KEY; 100,000 requests a month,
-- 20 a minute). The API only serves the most recent month, so every day is kept here and the history
-- grows from the first run. Filled by function "market".
create table if not exists public.etf_flow_daily (
  asset text not null,            -- BTC, ETH, SOL, XRP, ...
  country text not null,          -- US or HK
  day date not null,              -- trading day (US / HK market date)
  net_inflow double precision,    -- USD, settled T+1
  value_traded double precision,
  net_assets double precision,
  cum_inflow double precision,
  primary key (asset, country, day)
);
create table if not exists public.etf_ticker_daily (
  ticker text not null,
  day date not null,
  asset text not null, country text not null, name text,
  net_inflow double precision, cum_inflow double precision, net_assets double precision,
  share real, prem_dsc real, value_traded double precision,
  primary key (ticker, day)
);
do $$ declare t text; begin
  foreach t in array array['etf_flow_daily', 'etf_ticker_daily'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
  end loop;
end $$;

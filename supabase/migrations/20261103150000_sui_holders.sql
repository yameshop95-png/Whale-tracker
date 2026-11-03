-- Sui holders (see the sui function): Sui's public GraphQL lists every object of a type, so
--   SUI: every StakedSui object (owner + principal) -> stakers, summed per owner;
--   Sui tokens: every Coin<T> object (owner + balance) -> the full holder list, summed per owner.
-- Scans are summed into sui_holdings under a scan id; the finished scan's top owners are the pool read
-- daily. Private (no read policy): the web reads holder_bands / holder_daily like any coin.
create table if not exists public.sui_holdings (
  token text not null,
  scan_id text not null,
  address text not null,
  amount numeric not null default 0,
  primary key (token, scan_id, address)
);
alter table public.sui_holdings enable row level security;
create index if not exists sui_holdings_top on public.sui_holdings (token, scan_id, amount desc);

-- Adds a page of (address, amount) to a scan: the same owner on several pages is summed
create or replace function public.add_sui_holdings(p_token text, p_scan text, rows jsonb)
returns void language sql security definer set search_path = public as $$
  insert into sui_holdings (token, scan_id, address, amount)
  select p_token, p_scan, r->>'a', (r->>'v')::numeric from jsonb_array_elements(rows) r
  on conflict (token, scan_id, address) do update set amount = sui_holdings.amount + excluded.amount
$$;
revoke all on function public.add_sui_holdings(text, text, jsonb) from public, anon, authenticated;

select cron.schedule('whale-sui', '8-59/10 * * * *',
  $$select net.http_post(url := 'https://gatncbafceuxlimytgjo.supabase.co/functions/v1/sui', headers := public.cron_headers(), body := '{}'::jsonb, timeout_milliseconds := 5000)$$);

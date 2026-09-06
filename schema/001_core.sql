-- Sports card P&L — Supabase / Postgres schema
-- Mirrors the spreadsheet model: one typed ledger, everything else derived.

-- ---------------------------------------------------------------- enums
create type txn_type as enum ('purchase', 'sale', 'refund', 'expense');

create type platform as enum
  ('ebay', 'collx', 'card_show', 'local', 'lcs', 'online', 'other', 'na');

create type expense_category as enum
  ('supplies', 'postage_shipping', 'subscriptions', 'fees',
   'mileage', 'equipment', 'other');

-- ---------------------------------------------------------- transactions
create table transactions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null default auth.uid() references auth.users (id),

  occurred_on  date not null,          -- calendar day, not an instant
  type         txn_type not null,
  platform     platform not null default 'na',
  description  text not null,
  qty          integer not null default 1 check (qty > 0),

  -- money: numeric, never float. 0.1 + 0.2 <> 0.3 in binary floating point,
  -- and those cents compound straight into your tax figures.
  item_amount         numeric(10,2) not null default 0,
  shipping_charged    numeric(10,2) not null default 0,  -- sales only
  sales_tax_collected numeric(10,2) not null default 0,  -- sales only
  platform_fees       numeric(10,2) not null default 0,
  shipping_cost       numeric(10,2) not null default 0,  -- what YOU paid
  other_cost          numeric(10,2) not null default 0,

  expense_category expense_category,
  needs_review     boolean not null default false,
  notes            text,
  created_at       timestamptz not null default now(),

  -- What the buyer paid. This is the number a 1099-K reports.
  buyer_paid_total numeric(10,2) generated always as (
    case when type in ('sale', 'refund')
      then item_amount + shipping_charged + sales_tax_collected
    end
  ) stored,

  -- What actually moved in or out of your account.
  -- Sales tax is excluded: the marketplace collects and remits it, you never hold it.
  net_cash numeric(10,2) generated always as (
    case type
      when 'sale'   then   item_amount + shipping_charged
                         - platform_fees - shipping_cost - other_cost
      when 'refund' then -(item_amount + shipping_charged
                         - platform_fees - shipping_cost - other_cost)
      else               -(item_amount + shipping_charged
                         + platform_fees + shipping_cost + other_cost)
    end
  ) stored,

  -- Guardrails the spreadsheet could only ask for politely.
  constraint buyer_side_fields_are_sales_only check (
    type in ('sale', 'refund')
    or (shipping_charged = 0 and sales_tax_collected = 0)
  ),
  constraint expenses_need_a_category check (
    type <> 'expense' or expense_category is not null
  )
);

create index on transactions (user_id, occurred_on);
create index on transactions (user_id, type, occurred_on);

-- ------------------------------------------------------ inventory counts
-- The physical December 31 count. No database can derive this for you, and
-- without it Cost of Goods Sold is guesswork.
create table inventory_counts (
  user_id       uuid not null default auth.uid() references auth.users (id),
  tax_year      integer not null,
  counted_on    date not null,
  cards_on_hand integer,
  cost_basis    numeric(10,2) not null,   -- what you PAID, not market value
  method        text,
  notes         text,
  primary key (user_id, tax_year)
);

-- ------------------------------------------------------------------ RLS
alter table transactions     enable row level security;
alter table inventory_counts enable row level security;

create policy own_transactions on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy own_inventory on inventory_counts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------- views

-- Ledger with a running cash position. The window function replaces the
-- spreadsheet's O(n^2) SUMIFS trick.
-- security_invoker: the view enforces the querying user's RLS, not the
-- creator's. Without it this view returns every user's rows.
create view ledger_running with (security_invoker = on) as
select
  t.*,
  sum(t.net_cash) over (
    partition by t.user_id
    order by t.occurred_on, t.id
    rows between unbounded preceding and current row
  ) as running_total
from transactions t;

-- Daily cumulative position for the chart line. 180 days back through today.
create view daily_position with (security_invoker = on) as
select
  d.day,
  coalesce((
    select sum(t.net_cash) from transactions t
    where t.user_id = auth.uid() and t.occurred_on <= d.day
  ), 0) as cumulative_net
from generate_series(current_date - 179, current_date, interval '1 day') as d(day);

-- Rolling windows for the dashboard cards.
create view dashboard_windows with (security_invoker = on) as
select
  w.label,
  w.days,
  coalesce(sum(t.item_amount) filter (where t.type = 'sale'), 0)     as gross_sales,
  coalesce(sum(t.platform_fees + t.shipping_cost), 0)               as fees_and_shipping,
  coalesce(sum(t.item_amount) filter (where t.type = 'purchase'), 0) as spent_on_cards,
  coalesce(sum(t.net_cash), 0)                                       as net_cash,
  count(*) filter (where t.type = 'sale')                            as sale_count
from (values
  ('Last 7 days', 7), ('Last 30 days', 30), ('Last 90 days', 90),
  ('Last 180 days', 180), ('Last 365 days', 365)
) as w(label, days)
left join transactions t
  on t.user_id = auth.uid()
 and t.occurred_on >= current_date - w.days
group by w.label, w.days;

-- Schedule C building blocks, one row per tax year.
create view tax_summary with (security_invoker = on) as
with years as (
  select distinct extract(year from occurred_on)::int as tax_year
  from transactions where user_id = auth.uid()
),
totals as (
  select
    y.tax_year,
    coalesce(sum(t.buyer_paid_total) filter
      (where t.type = 'sale'   and t.platform = 'ebay'), 0)
    - coalesce(sum(t.buyer_paid_total) filter
      (where t.type = 'refund' and t.platform = 'ebay'), 0)  as gross_ebay,
    coalesce(sum(t.buyer_paid_total) filter
      (where t.type = 'sale'   and t.platform = 'collx'), 0)
    - coalesce(sum(t.buyer_paid_total) filter
      (where t.type = 'refund' and t.platform = 'collx'), 0) as gross_collx,
    coalesce(sum(t.buyer_paid_total) filter (where t.type = 'sale'), 0)
    - coalesce(sum(t.buyer_paid_total) filter (where t.type = 'refund'), 0)
                                                             as gross_all,
    coalesce(sum(t.sales_tax_collected) filter (where t.type = 'sale'), 0)
                                                             as sales_tax,
    coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost)
      filter (where t.type = 'purchase'), 0)                 as purchases,
    coalesce(sum(t.platform_fees), 0)                        as fees,
    coalesce(sum(t.shipping_cost) filter (where t.type = 'sale'), 0)
                                                             as postage,
    coalesce(sum(t.item_amount) filter
      (where t.type = 'expense' and t.expense_category = 'supplies'), 0)      as supplies,
    coalesce(sum(t.item_amount) filter
      (where t.type = 'expense' and t.expense_category = 'subscriptions'), 0) as subscriptions,
    coalesce(sum(t.item_amount) filter
      (where t.type = 'expense' and t.expense_category = 'mileage'), 0)       as mileage,
    coalesce(sum(t.item_amount) filter
      (where t.type = 'expense' and t.expense_category = 'equipment'), 0)     as equipment,
    coalesce(sum(t.item_amount) filter
      (where t.type = 'expense' and t.expense_category = 'other'), 0)         as other_expense,
    count(*) filter (where t.type = 'sale')                                   as sale_count
  from years y
  left join transactions t
    on t.user_id = auth.uid()
   and extract(year from t.occurred_on)::int = y.tax_year
  group by y.tax_year
)
select
  tt.tax_year,
  tt.gross_ebay,
  tt.gross_collx,
  tt.gross_all - tt.gross_ebay - tt.gross_collx as gross_other,
  tt.gross_all,
  tt.sales_tax,
  tt.gross_all - tt.sales_tax                   as adjusted_gross_receipts,
  coalesce(bi.cost_basis, 0)                    as beginning_inventory,
  tt.purchases,
  coalesce(ei.cost_basis, 0)                    as ending_inventory,
  coalesce(bi.cost_basis, 0) + tt.purchases
    - coalesce(ei.cost_basis, 0)                as cogs,
  tt.fees + tt.postage + tt.supplies + tt.subscriptions
    + tt.mileage + tt.equipment + tt.other_expense as total_expenses,
  (tt.gross_all - tt.sales_tax)
    - (coalesce(bi.cost_basis, 0) + tt.purchases - coalesce(ei.cost_basis, 0))
    - (tt.fees + tt.postage + tt.supplies + tt.subscriptions
       + tt.mileage + tt.equipment + tt.other_expense) as net_profit,
  tt.sale_count,
  (ei.tax_year is null)                          as ending_inventory_missing
from totals tt
left join inventory_counts bi
  on bi.user_id = auth.uid() and bi.tax_year = tt.tax_year - 1
left join inventory_counts ei
  on ei.user_id = auth.uid() and ei.tax_year = tt.tax_year;

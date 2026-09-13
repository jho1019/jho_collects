-- 010_tax_summary_expense_categories.sql — stop dropping expenses.
--
-- THE BUG. `expense_category` has seven values. tax_summary counted five:
--
--   supplies, subscriptions, mileage, equipment, other   -> counted
--   fees, postage_shipping                               -> SILENTLY DROPPED
--
-- The view's `fees` line is `sum(platform_fees)` — the marketplace-fee COLUMN,
-- which has nothing to do with an expense row categorised 'fees'. `postage` is
-- `sum(shipping_cost)` on sales, likewise unrelated to 'postage_shipping'. The
-- names collide; the money does not meet.
--
-- So an expense filed under either category vanished from `total_expenses` and
-- from `net_profit`, while still reducing `net_cash`. The ledger and the tax
-- figures disagreed, and nothing said so.
--
-- Latent since Phase 1. It surfaced when a $180 grading bill was filed under
-- 'fees': total_expenses stayed at 18.24 and profit was overstated by $180.
--
-- SECOND, SAME-SHAPED BUG. Every expense category summed `item_amount` alone,
-- ignoring `shipping_cost` and `other_cost` on expense rows — money that
-- net_cash subtracts and no tax line captured. Purchases already aggregate all
-- three (`item_amount + shipping_cost + other_cost`); expenses now match.
-- No current row has a non-zero value there, so this changes no figure today.
-- It closes the hole before something silently falls through it.
--
-- Columns are unchanged, so CREATE OR REPLACE is sufficient.

create or replace view tax_summary with (security_invoker = on) as
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

    -- marketplace fees withheld on any row, PLUS expenses filed as 'fees'
    -- (grading, prep, and anything else billed as a service fee)
    coalesce(sum(t.platform_fees), 0)
    + coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost) filter
      (where t.type = 'expense' and t.expense_category = 'fees'), 0)          as fees,

    -- postage paid to ship a sale, PLUS expenses filed as 'postage_shipping'
    -- (a roll of labels, a stamp run that belongs to no single order)
    coalesce(sum(t.shipping_cost) filter (where t.type = 'sale'), 0)
    + coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost) filter
      (where t.type = 'expense' and t.expense_category = 'postage_shipping'), 0) as postage,

    coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost) filter
      (where t.type = 'expense' and t.expense_category = 'supplies'), 0)      as supplies,
    coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost) filter
      (where t.type = 'expense' and t.expense_category = 'subscriptions'), 0) as subscriptions,
    coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost) filter
      (where t.type = 'expense' and t.expense_category = 'mileage'), 0)       as mileage,
    coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost) filter
      (where t.type = 'expense' and t.expense_category = 'equipment'), 0)     as equipment,
    coalesce(sum(t.item_amount + t.shipping_cost + t.other_cost) filter
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

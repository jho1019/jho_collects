-- 026_profit_views.sql — cost-based profit for the dashboard scoreboard.
--
-- Read-only views. Nothing here writes, and nothing touches `transactions`,
-- so net_cash and every cash figure are unchanged. Run in the Supabase SQL
-- editor after 025. Safe to run twice (CREATE OR REPLACE).
--
-- The web app does NOT depend on these: web/lib/dashboard/profit.ts computes
-- the identical numbers from transactions + cards, so /dashboard works with or
-- without 026. These exist so the same figures are queryable in SQL (and so a
-- later version can push bucketing into Postgres). Keep the two in step: if a
-- definition changes here, change profit.ts and its tests too.
--
-- Definitions (SPEC_E_SCOREBOARD.md 10.1):
--   sale profit = sale.net_cash − Σ acquisition_cost of the cards linked by
--                 cards.sale_transaction_id. A null cost counts as 0 and
--                 marks the sale missing_cost, as does a sale with no linked
--                 card (bulk lots). Opening-stock cards keep their cost in
--                 inventory_counts, not per card, so they are missing_cost
--                 until a per-card cost is entered.
--   refunds     = their own (negative) net_cash; no card cost is credited back.
--   expenses    = their own (negative) net_cash; they reduce profit.
--   purchases   = never profit. Cost reaches profit only through COGS above.
--   trades      = not profit events (no sale row). Open question 13.1.
--
-- channel: ebay; card_show / local / lcs = shows; everything else = other.
-- category: min(category) over linked cards; null when nothing is linked.

create or replace view sale_profit with (security_invoker = on) as
select t.id,
       t.occurred_on,
       t.platform,
       case when t.platform = 'ebay' then 'ebay'
            when t.platform in ('card_show', 'local', 'lcs') then 'shows'
            else 'other' end                              as channel,
       t.net_cash                                         as revenue_after_fees,
       coalesce(c.cogs, 0)::numeric(10,2)                 as cogs,
       (t.net_cash - coalesce(c.cogs, 0))::numeric(10,2)  as profit,
       (coalesce(c.cards_linked, 0) = 0
         or coalesce(c.cards_missing_cost, 0) > 0)        as missing_cost,
       c.category
from transactions t
left join lateral (
  select sum(acquisition_cost)                            as cogs,
         count(*)                                         as cards_linked,
         count(*) filter (where acquisition_cost is null) as cards_missing_cost,
         min(category::text)                              as category
  from cards
  where sale_transaction_id = t.id
    and user_id = auth.uid()
) c on true
where t.type = 'sale'
  and t.user_id = auth.uid();

comment on view sale_profit is
  'One row per sale: net_cash minus the cost of linked cards. missing_cost = no linked card, or a linked card with no cost (profit is overstated). Mirrors web/lib/dashboard/profit.ts.';

-- One row per day with any profit event. Days with none are absent; callers
-- fill gaps. `sales` counts sale rows only (refunds and expenses are 0).
create or replace view profit_daily with (security_invoker = on) as
select day,
       sum(profit)::numeric(10,2) as profit,
       sum(sales)::integer        as sales
from (
  select occurred_on as day, profit, 1 as sales
  from sale_profit
  union all
  select occurred_on, net_cash, 0
  from transactions
  where type = 'refund' and user_id = auth.uid()
  union all
  select occurred_on, net_cash, 0
  from transactions
  where type = 'expense' and user_id = auth.uid()
) x
group by day;

comment on view profit_daily is
  'Net profit per day: sale profit + refund net_cash + expense net_cash. Purchases excluded (their cost arrives as COGS when the card sells). Cumulative P&L is a running sum of this, reset at the range start.';

-- 013_daily_cash.sql — one row per day that has transactions, for the
-- Phase 9 calendar.
--
-- The calendar queries this scoped to the visible month. It deliberately does
-- NOT reuse Home's old full-transactions fetch (app/(app)/page.tsx before
-- Phase 9) — that query existed to build a cumulative series and pulls every
-- row ever. A calendar month needs only that month's net movement per day.

create view daily_cash with (security_invoker = on) as
select user_id,
       occurred_on as day,
       sum(net_cash)  as net_movement,
       count(*)       as txn_count
from transactions
where user_id = auth.uid()
group by user_id, occurred_on;

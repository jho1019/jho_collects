-- 016_show_summary.sql — per-show P&L.
--
-- One row per show: deals grouped through deal_summary, plus unattached
-- show-level expenses (admission, table fee, parking — transactions with
-- this show_id and no deal_id), and a true net that includes both. That
-- last figure is the point of the phase: a show netting +41.00 across deals
-- but costing $10 to get into netted +31.00, and until now there was
-- nowhere to say so.
--
-- Left joins throughout — a show with zero deals (the 2 September fixture)
-- must report a row with zeroes, not omit itself or error.
create view show_summary with (security_invoker = on) as
select
  s.id                             as show_id,
  s.name,
  s.starts_on,
  s.ends_on,
  s.status,
  s.needs_review,
  coalesce(d.deal_count, 0)        as deal_count,
  coalesce(d.cards_in, 0)          as cards_in,
  coalesce(d.cards_out, 0)         as cards_out,
  coalesce(d.deal_net_cash, 0)     as deal_net_cash,
  coalesce(e.expense_net_cash, 0)  as unattached_net_cash,
  coalesce(d.deal_net_cash, 0) + coalesce(e.expense_net_cash, 0)
                                    as net_cash
from shows s
left join lateral (
  select
    count(*)                    as deal_count,
    coalesce(sum(ds.net_cash), 0)  as deal_net_cash,
    coalesce(sum(ds.cards_in), 0)  as cards_in,
    coalesce(sum(ds.cards_out), 0) as cards_out
  from deals dl
  join deal_summary ds on ds.deal_id = dl.id
  where dl.show_id = s.id
) d on true
left join lateral (
  select sum(t.net_cash) as expense_net_cash
  from transactions t
  where t.show_id = s.id and t.deal_id is null
) e on true
where s.user_id = auth.uid();

comment on view show_summary is
  'Deal cash comes through deal_summary (dl.show_id = s.id), never by summing transactions.deal_id directly — that would require re-deriving the per-deal figures deal_summary already computes. Unattached expenses are transactions.show_id with a null deal_id; a transaction that is both would be double-counted, which is exactly why the deal-leg insert in record_trade() never sets show_id on the transaction itself.';

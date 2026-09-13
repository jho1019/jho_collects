-- 011_record_trade_cash_in.sql — stop double-counting cash received in a trade.
--
-- THE BUG. When cards came IN and cash was RECEIVED (v_dir = 'received'),
-- record_trade did two things with the same dollars: it wrote a `sale`
-- transaction for the cash (which lowers net_cash, correctly — that's the
-- whole point of booking the cash leg), AND it subtracted that same cash
-- amount from the incoming card's carried basis. The cash was charged
-- against the deal twice: once as a real transaction row, once again as a
-- phantom reduction to what the received card cost.
--
-- Booking the sale and carrying the received card's basis whole is the
-- treatment that holds this schema's central rule intact: one transaction
-- row per cash movement (see CLAUDE.md). The alternative — reducing basis
-- and writing nothing — would make a cash-in trade produce no transaction
-- at all, which contradicts that rule.
--
-- Only deal_id 3 is affected in current data, and its received card's
-- acquisition_cost is already null (unknown basis, flagged via
-- needs_review), so there is nothing to backfill.
--
-- With the subtraction gone, `v_total_basis < 0` is unreachable (v_carried
-- and v_cash are both always >= 0). Left in place: it costs nothing and
-- documents the invariant.
--
-- Same signature as 007, so CREATE OR REPLACE is sufficient.

create or replace function record_trade(
  p_out_card_ids    bigint[]  default '{}'::bigint[],
  p_in_titles       text[]    default '{}'::text[],
  p_in_est_values   numeric[] default null,
  p_cash_amount     numeric   default 0,
  p_cash_direction  text      default null,
  p_platform        platform  default 'card_show',
  p_occurred_on     date      default current_date,
  p_event_name      text      default null,
  p_counterparty_id bigint    default null,
  p_notes           text      default null,
  p_deal_id         bigint    default null
) returns bigint
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deal_id      bigint;
  v_txn_id       bigint;
  v_card         cards%rowtype;
  v_on           date    := coalesce(p_occurred_on, current_date);
  v_cash         numeric := coalesce(p_cash_amount, 0);
  v_dir          text    := lower(nullif(btrim(coalesce(p_cash_direction, '')), ''));
  v_carried      numeric := 0;
  v_null_basis   int     := 0;
  v_out_count    int     := coalesce(array_length(p_out_card_ids, 1), 0);
  v_in_count     int     := coalesce(array_length(p_in_titles, 1), 0);
  v_needs_review boolean := false;
  v_total_basis  numeric := 0;
  v_est_sum      numeric := 0;
  v_use_prorata  boolean := false;
  v_alloc        numeric;
  v_running      numeric := 0;
  v_est          numeric;
  v_cost_known   boolean;
  i              int;
begin
  if v_dir is not null and v_dir not in ('paid', 'received') then
    raise exception 'p_cash_direction must be ''paid'' or ''received'', got %', p_cash_direction;
  end if;
  if v_cash < 0 then
    raise exception 'cash amount must be positive; direction is carried by p_cash_direction, not by the sign';
  end if;

  -- Cash with no direction is unrecoverable later, and guessing it inverts the
  -- sign of a real Schedule C figure. Record everything else, flag the deal.
  if v_cash > 0 and v_dir is null then
    v_needs_review := true;
  end if;

  if p_deal_id is null then
    insert into deals (occurred_on, counterparty_id, event_name, notes)
    values (v_on, p_counterparty_id, p_event_name, p_notes)
    returning id into v_deal_id;
  else
    select id into v_deal_id from deals
     where id = p_deal_id and user_id = auth.uid();
    if not found then
      raise exception 'deal % not found', p_deal_id;
    end if;
  end if;

  -- Outgoing: lock each row, refuse anything that already left, sum the basis.
  for i in 1 .. v_out_count loop
    select * into v_card from cards
     where id = p_out_card_ids[i] and user_id = auth.uid()
     for update;

    if not found then
      raise exception 'card % not found', p_out_card_ids[i];
    end if;
    if v_card.status in ('sold', 'traded') then
      raise exception 'card % has already left inventory (% on %)',
        v_card.id, v_card.status, v_card.exited_on;
    end if;

    if v_card.acquisition_cost is null then
      v_null_basis := v_null_basis + 1;
    else
      v_carried := v_carried + v_card.acquisition_cost;
    end if;
  end loop;

  -- A missing basis must be VISIBLE, not silent. Same principle as
  -- tracked_inventory.cards_without_cost.
  if v_null_basis > 0 then
    v_needs_review := true;
  end if;

  -- The cash leg: exactly one row, for the cash and nothing else.
  if v_cash > 0 and v_dir is not null then
    insert into transactions (
      occurred_on, type, platform, description, qty, item_amount, deal_id, notes
    ) values (
      v_on,
      case when v_dir = 'paid' then 'purchase'::txn_type else 'sale'::txn_type end,
      p_platform,
      coalesce(nullif(btrim(coalesce(p_event_name, '')), ''), 'deal') || ' — deal ' || v_deal_id
        || case when v_dir = 'paid' then ' (cash out)' else ' (cash in)' end,
      1, v_cash, v_deal_id, p_notes
    ) returning id into v_txn_id;
  end if;

  -- Dispose the outgoing cards. status='traded' with sale_transaction_id left
  -- NULL is precisely what keeps net_cash honest: no receipt is invented.
  if v_out_count > 0 then
    update cards
       set status           = 'traded',
           disposed_deal_id = v_deal_id,
           exited_on        = v_on
     where id = any (p_out_card_ids) and user_id = auth.uid();

    update card_aliases
       set retired_at = now()
     where card_id = any (p_out_card_ids) and retired_at is null;
  end if;

  -- Incoming basis = cash paid + carried basis. Cash RECEIVED is already
  -- booked above as its own sale transaction and must not also reduce
  -- basis here — that double-counts the same dollars. See this file's
  -- header.
  if v_in_count > 0 then
    v_total_basis := v_carried
                     + case when v_dir = 'paid' then v_cash else 0 end;
    -- Unreachable now (v_carried and v_cash are both >= 0). Left in place;
    -- it costs nothing and documents the intent.
    if v_total_basis < 0 then
      v_total_basis  := 0;
      v_needs_review := true;
    end if;

    -- Pro-rata by est_value only when every incoming card has one.
    -- When every outgoing card had an unknown basis and no cash moved, NOTHING
    -- is known about this card's cost. Writing 0.00 would assert that it cost
    -- nothing — understating ending inventory and hiding the gap from
    -- tracked_inventory.cards_without_cost, which counts nulls. Write null so
    -- the gap stays visible there as well as on deals.needs_review.
    -- A genuinely free card (no cards out, no cash) still gets 0.00, correctly.
    v_cost_known := not (v_null_basis > 0 and v_total_basis = 0);

    if p_in_est_values is not null
       and coalesce(array_length(p_in_est_values, 1), 0) = v_in_count
       and not exists (select 1 from unnest(p_in_est_values) as x where x is null) then
      select coalesce(sum(x), 0) into v_est_sum from unnest(p_in_est_values) as x;
      v_use_prorata := v_est_sum > 0;
    end if;

    for i in 1 .. v_in_count loop
      if v_use_prorata then
        v_alloc := round(v_total_basis * (p_in_est_values[i] / v_est_sum), 2);
      else
        v_alloc := round(v_total_basis / v_in_count, 2);
      end if;
      -- Last card absorbs the rounding remainder so the parts sum to the whole.
      if i = v_in_count then
        v_alloc := v_total_basis - v_running;
      end if;
      v_running := v_running + v_alloc;

      v_est := case
                 when p_in_est_values is not null
                  and coalesce(array_length(p_in_est_values, 1), 0) >= i
                 then p_in_est_values[i]
               end;

      -- acquisition_transaction_id is deliberately NOT set. The cash row covers
      -- the whole deal, not this card, and most of this basis carried over from
      -- cards given up rather than from that payment.
      insert into cards (
        title, status, acquisition_cost, acquired_on, acquired_deal_id,
        est_value, est_valued_on, is_opening_stock
      ) values (
        p_in_titles[i], 'held',
        case when v_cost_known then v_alloc end,
        v_on, v_deal_id,
        v_est, case when v_est is not null then v_on end, false
      );
    end loop;
  end if;

  if v_needs_review then
    update deals set needs_review = true where id = v_deal_id;
  end if;

  return v_deal_id;
end;
$$;

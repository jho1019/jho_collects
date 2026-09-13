-- 009_alias_whitespace.sql — make whitespace irrelevant to an alias.
--
-- BACKGROUND. 008 fixed find_cards to compare `lower(btrim(a.alias))` against
-- `lower(btrim(q))`. Before that it trimmed only the query, so an alias stored
-- with surrounding whitespace could never match by exact alias and silently
-- degraded to a fuzzy prompt — the one thing naming a card exists to prevent.
--
-- THE HOLE THAT FIX OPENS. The 004 uniqueness guarantee is:
--
--   create unique index card_aliases_active_uniq
--     on card_aliases (user_id, lower(alias)) where retired_at is null;
--
-- That indexes `lower(alias)`, untrimmed. 'the kobe' and 'the kobe ' are
-- therefore two distinct active aliases as far as the index is concerned — but
-- one identical alias as far as the trimmed comparison is concerned. Both would
-- match a single query, and find_cards' `exact` branch would return TWO cards.
--
-- That branch's whole contract is that an alias resolves to exactly one card by
-- database constraint, which is what lets the skill skip the "which one?"
-- prompt. Two rows there is not a cosmetic bug: it makes the skill act on an
-- ambiguous match without asking.
--
-- Before 008 the two simply never matched anything, so the hole was harmless.
-- Fixing the lookup is what makes closing it necessary.

-- 1. Normalise what is already stored. name_card() has always trimmed on
--    insert, so anything untrimmed arrived by another path (a CSV import, a
--    direct UPDATE). Whitespace-only change; no alias text is altered.
update card_aliases
   set alias = btrim(alias)
 where alias <> btrim(alias);

-- 2. Re-key uniqueness on the trimmed, lowered form, so the constraint matches
--    what find_cards actually compares. Partial on retired_at, exactly as in
--    004 — selling a card still frees its nicknames for reuse.
drop index if exists card_aliases_active_uniq;

create unique index card_aliases_active_uniq
  on card_aliases (user_id, lower(btrim(alias))) where retired_at is null;

-- 3. name_card's duplicate check had the same asymmetry: it compared the
--    untrimmed stored alias against a trimmed argument, so it would fail to
--    spot a whitespace variant and report the wrong owner — or let the insert
--    hit the index error instead of the readable message.
create or replace function name_card(p_card_id bigint, p_alias text)
returns bigint
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_id bigint;
  v_owner bigint;
begin
  if btrim(p_alias) = '' then
    raise exception 'alias cannot be blank';
  end if;

  select a.card_id into v_owner
    from card_aliases a
   where a.user_id = auth.uid()
     and a.retired_at is null
     and lower(btrim(a.alias)) = lower(btrim(p_alias));

  if found and v_owner <> p_card_id then
    raise exception '% is already the nickname for card %', btrim(p_alias), v_owner;
  end if;

  insert into card_aliases (card_id, alias)
  values (p_card_id, btrim(p_alias))
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$fn$;

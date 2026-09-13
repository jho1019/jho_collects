-- 008_find_cards_word_similarity.sql — make short phrases resolve.
--
-- THE BUG. `similarity()` compares trigram sets over the WHOLE string, so its
-- score falls as the title grows. Once titles became specific
-- ("2018 Topps Update Shohei Ohtani 3-Game HR Streak PSA 9"), short phrases
-- stopped clearing the 0.3 threshold and find_cards returned NOTHING —
-- not a list to choose from, nothing. Measured against real inventory:
--
--   'kobe'          similarity 0.16 -> 0 matches
--   'shohei'        similarity 0.23 -> 0 matches
--   'the shohei'    similarity 0.20 -> 0 matches
--   'shohei ohtani' similarity 0.45 -> 3 matches, of 4 real Shoheis
--
-- That last one is the dangerous case: a silent partial result. And a no-match
-- does not merely inconvenience — per the skill it falls through to a bare cash
-- row with needs_review, so the card never gets closed.
--
-- Phase 3.5 predicted exactly this: "Tune the threshold against real titles —
-- too loose returns noise, too tight misses 'jordan psa10'." It was too tight.
--
-- THE FIX. `word_similarity(query, text)` scores the query against the best
-- matching *continuous extent* of the text rather than the whole of it, so a
-- one-word query against a long title scores on its merits. Same phrases:
--
--   'kobe'          word_similarity 1.00 -> 1 match
--   'shohei'        word_similarity 1.00 -> 4 matches
--   'the shohei'    word_similarity 0.64 -> 4 matches
--   'shohei ohtani' word_similarity 1.00 -> 4 matches
--
-- Threshold 0.5, not the 0.6 default: 'the kobe' scores 0.56 because the
-- article is dead weight, and people say "the kobe". An unrelated query still
-- fails comfortably ('bryce young' against this inventory scores 0.25).
--
-- ADDITIVE, NOT A REPLACEMENT. The `%` operator stays in the predicate, so
-- everything that matched before still matches and the GIN index still serves
-- that branch. word_similarity is an extra way IN, never a filter.
--
-- The threshold is written as a literal comparison rather than the `<%`
-- operator on purpose: `<%` reads pg_trgm.word_similarity_threshold, a GUC
-- that session state or a future `SET` could quietly change. An explicit 0.5
-- means this function returns the same rows whoever calls it.

create or replace function find_cards(q text)
returns table (
  id bigint, sku text, title text, year text, set_name text,
  parallel text, grader text, grade text, status card_status,
  acquisition_cost numeric, acquired_on date,
  matched_alias text, match_type text, score real
)
language sql stable
set search_path = public, pg_temp
as $$
  with exact as (
    select c.id, c.sku, c.title, c.year, c.set_name, c.parallel,
           c.grader, c.grade, c.status, c.acquisition_cost, c.acquired_on,
           a.alias as matched_alias, 'alias'::text as match_type, 1.0::real as score
    from card_aliases a
    join cards c on c.id = a.card_id
    where a.user_id = auth.uid()
      and a.retired_at is null
      -- btrim BOTH sides. The 004 version trimmed only the query, so an alias
      -- stored with surrounding whitespace could never match by exact alias —
      -- not even by typing the whitespace, since the query side is trimmed and
      -- the stored side was not. Such an alias silently degraded to a fuzzy
      -- prompt every time, which is exactly what naming a card is meant to
      -- avoid. name_card() trims on insert, so this only bites aliases written
      -- by some other path (a CSV import, a direct UPDATE).
      and lower(btrim(a.alias)) = lower(btrim(q))
      and c.status not in ('sold', 'traded')
  ),
  fuzzy as (
    select c.id, c.sku, c.title, c.year, c.set_name, c.parallel,
           c.grader, c.grade, c.status, c.acquisition_cost, c.acquired_on,
           null::text as matched_alias, 'fuzzy'::text as match_type,
           greatest(
             similarity(c.search_text, q),
             word_similarity(q, c.search_text),
             coalesce((select max(greatest(similarity(a2.alias, q),
                                           word_similarity(q, a2.alias)))
                       from card_aliases a2
                       where a2.card_id = c.id and a2.retired_at is null), 0)
           ) as score
    from cards c
    where c.user_id = auth.uid()
      and c.status not in ('sold', 'traded')
      and not exists (select 1 from exact)
      and (
        -- whole-string trigram match (indexed)
        c.search_text % q
        -- or the phrase matches some run of words inside the title
        or word_similarity(q, c.search_text) >= 0.5
        or exists (select 1 from card_aliases a3
                   where a3.card_id = c.id and a3.retired_at is null
                     and (a3.alias % q or word_similarity(q, a3.alias) >= 0.5))
      )
  )
  select * from exact
  union all
  select * from fuzzy
  order by score desc, acquired_on desc nulls last
  limit 10;
$$;

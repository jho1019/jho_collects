---
name: comp-entry
description: Record sold-price comps against items on the buying list, and add cards to the buying list. Use when the user gives a market value for a card they are hunting ("comp for the Yamamoto sapphire PSA 10 is $180") or pastes a set of sold prices for one card. Also use for "add X to my buying list" / "I'm looking for X". Not for cards already owned or sales the user made (that's card-entry).
---

# Comp entry

Read `docs/DECISIONS.md` before changing anything here. Tables: `buying_list`,
`comps`, `pricing_settings`; target math lives in the `buying_targets` view
(`schema/017_buying_list.sql`) — never recompute it in the skill.

## Resolve the item first

Match the title against `buying_list` (any status) with `ilike` on `title`,
`player`, and `set_name`/`parallel`/`grader` words. Exactly one match: use it.
Several: list them and ask which. **No match:** offer to add it to the buying
list (`purpose` defaults to `pc`; ask only if they mention reselling), since a
comp for an untracked card usually means they meant to track it. Never invent
a title, year, grade or card number — leave unknown fields null.

## Two entry paths

**Single figure** — "comp for the Yamamoto sapphire PSA 10 is $180". One
`comps` row (`price`, `source` if stated, `observed_on` = today unless said).
**Writes through, no preview.** Reply with the resulting `buying_targets` row:
comp, target all-in, target listing price.

**Pasted set of sold prices** — one row per observation, **previewed first**
(the Phase 11 batch rule). Show a table (date, price, source), the outlier
flags, and the derived comp. Ask once for the whole batch with
`AskUserQuestion`; write nothing on a decline.

## Deriving one comp from several sales

**Use the median, not the mean.** Outliers run both ways (a best offer far
below ask, a bidding war, a mislabelled grade) and one moves a mean a long
way. $170, $180, $400 → comp is **$180**, not $250. For an even count, average
the middle two. Say the median in the preview.

By default write the observations as individual rows, then one derived row
(`source` = `'median of N'`, `notes` listing the inputs) only if the user
wants a single figure recorded. The view uses the most recent comp by
`observed_on`, then `created_at`, so the derived row must be inserted last
and share the latest `observed_on`.

## Writing

No CLI. Insert directly via SQL with `user_id` set explicitly from
`OWNER_USER_ID` in `.env.local` (`default auth.uid()` has no session on a
direct connection — same as `release-entry`).

```sql
insert into comps (user_id, buying_list_id, price, source, observed_on)
values (:owner, :item, 180.00, 'ebay sold', current_date);
```

Adding to the buying list:

```sql
insert into buying_list (user_id, title, player, year, set_name, card_number,
                         parallel, grader, grade_min, purpose)
values (:owner, ...);
```

Marking bought: `update buying_list set status = 'bought', bought_card_id = :card
where id = :id;` — always with the `WHERE`.

## Never

- Write a batch before the preview is confirmed.
- Use a mean to derive a comp.
- Apply seller fees to a `pc` item — fees are the seller's cost.
- Store a target or invent `pricing_settings` values; targets are computed.
- Overwrite or delete an old comp to "update" one — add a new dated row.

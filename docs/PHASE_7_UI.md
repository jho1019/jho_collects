Phase 7 — Theme and navigation

Split the single-page dashboard into routes, give it a colour system, and put a left nav in front of it.

Ship 011 first, separately

`record_trade()` double-counts cash received in a trade. It writes a `sale` transaction for the cash *and* subtracts the same amount from the received card's carried basis — the same dollars charged against you twice.

The fix is `schema/011_record_trade_cash_in.sql`: delete the basis reduction, keep the sale.

```
-- before
v_total_basis := v_carried
  + case when v_dir = 'paid' then v_cash else 0 end
  - case when v_dir = 'received' then v_cash else 0 end;

-- after
v_total_basis := v_carried
  + case when v_dir = 'paid' then v_cash else 0 end;
```

Booking the sale and carrying basis whole is the treatment that holds the phase's central rule intact: one transaction row per cash movement. The alternative — reducing basis and writing nothing — makes a cash-in trade produce no transaction at all, which contradicts it.

With the subtraction gone, the `v_total_basis < 0` clamp becomes unreachable. Leave it; it costs nothing and documents the intent.

Deal 3 is the only affected row and its received card's cost is null, so there is nothing to backfill. Do not wait for this phase. It is a wrong number in a tax figure.

What exists today

`app/` has exactly three routes: `page.tsx`, `data/`, `login/`. Everything — position cards, cash chart, ledger history, margin by band, card inventory, buyer list — renders on `/`. Any one of those sections currently costs a fetch of all of them.

`components/` is already split along the lines this phase needs: `PositionCards`, `CashChart`, `MarginByBand`, `CardInventory`, `BuyerList`. The work is moving data fetching to the right route, not rewriting components.

`globals.css` holds two variables and nothing else. There is no token system to edit; there is one to write.

Colour system

Tailwind v4 is CSS-first — no `tailwind.config.js`. Tokens go in `@theme` in `app/globals.css` and generate utilities (`bg-page`, `text-ink`) automatically.

```css
@import "tailwindcss";

@theme {
  --color-page:        #f5f0ee;  /* page background */
  --color-surface:     #ffffff;  /* cards, tables, nav */
  --color-brand:       #3b67b7;  /* primary, links, positive figures */
  --color-brand-soft:  #8ba1ca;  /* borders, dividers, inactive icons */
  --color-accent:      #d7728d;  /* fills, badges, chart bars */
  --color-accent-ink:  #a83e5c;  /* negative figures as TEXT */
  --color-ink:         #1c2436;  /* body text */
  --color-ink-muted:   #4a5568;  /* secondary text, labels */
}
```

Measured contrast against `--color-page`:

| token | ratio | use |
|---|---|---|
| `--color-ink` | 13.7 | body text |
| `--color-ink-muted` | 6.7 | labels, secondary |
| `--color-brand` | 4.9 | text, buttons, links |
| `--color-accent-ink` | 5.3 | negative figures |
| `--color-accent` | 2.8 | **fills only, never text** |
| `--color-brand-soft` | 2.3 | **borders only, never text** |

`#d7728d` and `#8ba1ca` both fail AA for text. They are shapes, not words. A dollar figure rendered in `--color-accent` is a bug.

Two greys were sampled, `#f5f0ee` and `#f4eff0`. They differ by one RGB unit and cannot carry a page-versus-card hierarchy. Only the first is a token; card surfaces use white, which gives real separation.

Positive and negative

The palette has no green. Positive figures use `--color-brand`, negative use `--color-accent-ink`.

This is deliberate, not a workaround: blue against rose stays distinguishable under deuteranopia, where red against green does not. The cost is that blue does not *read* as positive on its own, so **every figure carries an explicit sign or arrow**. Colour is emphasis here, never the only carrier of meaning.

Chart colours

recharts takes colour props, not classes. SVG `fill` and `stroke` accept `var(--color-brand)`, so the chart reads the same tokens as everything else — use that wherever recharts renders directly.

Do not fork the palette into a TypeScript constants file "just for the chart". Two copies drift, and the second copy is the one nobody updates. If some recharts prop genuinely needs a literal, read it once from `getComputedStyle` or accept the single hard-coded value with a comment pointing at the token.

Routes

Six destinations. Five are the existing sections; the sixth already exists and is currently unreachable except by typing the URL.

| route | content | source |
|---|---|---|
| `/` | position cards, cash chart, ledger history | `PositionCards`, `CashChart`, `ledger_running`, `dashboard_windows` |
| `/deals` | per-deal and per-show view | `deal_summary` — **net new, no component exists** |
| `/inventory` | cards by status, tracked summary | `CardInventory`, `tracked_inventory` |
| `/insights` | margin by price band | `MarginByBand` |
| `/people` | buyer and vendor list | `BuyerList`, `buyer_summary` |
| `/data` | table CSV, eBay report | existing, unchanged |

Each route queries only its own views. This is the point of the split as much as the nav is.

`/people`, not `/buyers`. That table now holds show vendors you buy *from*. The column comment already calls the name a known misnomer; the nav label is where that stops propagating into new surfaces.

Nav

A left sidebar on `--color-surface`, fixed, with the five sections in the order above. `/data` sits at the bottom, visually separated — it is a utility, not a section.

The active item is marked with `--color-brand`: a left border or filled background, plus a weight change. Never colour alone. Inactive icons use `--color-brand-soft`.

**The sidebar must not render on `/login`.** In the App Router that means a route group: move the six destinations under `app/(app)/` with the sidebar in `app/(app)/layout.tsx`, and leave `login/` outside it. Putting the nav in the root `layout.tsx` wraps the login page in chrome for a user who is not signed in.

Flag counts instead of a review page

There is no Review section. `needs_review` surfaces in two places instead: a count badge on the **Deals** nav item, and a marker on the affected rows within each screen.

Four of six deals currently carry the flag and nothing in the app shows it — flagged rows are reachable only through `entry.py review`, which means they do not get reviewed.

Exit check

- `/`, `/deals`, `/inventory`, `/insights`, `/people`, `/data` all render, each fetching only the views it displays. Loading `/people` issues no query against `deal_summary` or `ledger_running`.
- `/login` renders with **no sidebar**, signed out.
- Every colour in every component resolves to a token. A grep for `#` in `components/` and `app/` returns nothing outside `globals.css`.
- The cash chart's series colour is the same token as the rest of the UI, not a duplicate literal.
- A negative cash figure renders in `--color-accent-ink` **and** carries a minus sign. Covering the screen in greyscale still tells you it is negative.
- `/deals` lists all six deals with date, event, counterparty, derived kind, net cash, and cards in/out; expanding one shows its transaction rows and the cards that moved in each direction.
- The Deals nav item shows a badge of 4 against current data.
- `/data` is reachable from the nav without typing a URL.
- No route reads `sold_on`, which no longer exists.

Decisions to record in DECISIONS.md

- Tokens live in `@theme` in `globals.css`. Tailwind v4 has no config file; do not add one.
- `--color-accent` and `--color-brand-soft` are fills and borders only. Never text.
- Positive is brand blue, negative is accent ink, and every figure carries an explicit sign. Colour never carries meaning alone.
- The chart reads the same tokens as the UI. The palette is not duplicated in TypeScript.
- Authenticated routes live in the `(app)` route group so `/login` stays outside the nav layout.
- `/people` supersedes "Buyers" in the UI. The table name stays for now.

Not in this phase

Dark mode — the palette is light-only and a half-built dark theme is worse than none. A Taxes screen, a Review screen, sell-through and aging on `/insights`, a deals entry UI (deals are still entered through the skill), per-show grouping, and any change to `/data` beyond making it reachable.

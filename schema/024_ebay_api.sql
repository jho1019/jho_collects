-- 024_ebay_api.sql — state for the eBay API service (web/app/api/ebay/*).
--
-- NOT the ledger. Nothing here is a cash event, and nothing in the eBay API
-- service ever INSERTs into `transactions`: eBay sale rows, fees and label
-- costs still arrive only through the Seller Hub transaction-report import
-- (CLAUDE.md, "Never invent fee amounts"). These tables hold OAuth tokens,
-- configuration, an audit log of listing changes, the sku/offer/listing ->
-- card links, and the idempotency record for the sold-order sync.
--
-- THE SOLD-ORDER SYNC (web/lib/ebay-api/sync/) closes cards; it does not
-- record sales. It finds the importer's sale row by the key both sides share:
--   transactions.order_ref   = Fulfillment API orderId   ("Order number")
--   transactions.item_number = Fulfillment API legacyItemId ("Item ID")
-- and links the card to that row via ebay_close_card_for_sale(). A card whose
-- sale row has not been imported yet waits as `pending_ledger` — cards.status
-- cannot be 'sold' without a sale_transaction_id (003's CHECK), and the sync
-- will not invent one. See docs/DECISIONS.md, "The eBay API sync never writes
-- ledger cash rows".
--
-- Access model: RLS is ENABLED with NO policies, and table privileges are
-- revoked from anon/authenticated/public. Only the service-role key (used
-- server-side by the route handlers via web/lib/supabase/admin.ts) can read
-- or write them. The refresh token in ebay_tokens is an 18-month bearer
-- credential for the eBay seller account — it must never be readable with
-- the publishable key. Revoking privileges is belt-and-braces on top of RLS
-- (same lesson as 014's PUBLIC execute grant: deny explicitly, don't rely on
-- one layer). The two functions below are likewise service_role only.
--
-- Run by hand in the Supabase SQL editor. Idempotent (`if not exists`,
-- `create or replace`), so a second run is a no-op.

-- ------------------------------------------------------------------ tokens
-- One row per (environment, seller). The refresh token lasts ~18 months; the
-- access token ~2 hours and is refreshed on demand. eBay does NOT rotate the
-- refresh token on a refresh grant, so a refresh only rewrites the access
-- token columns.
create table if not exists ebay_tokens (
  id                        bigint generated always as identity primary key,
  environment               text not null check (environment in ('production', 'sandbox')),
  seller                    text not null default 'default',
  access_token              text,
  access_token_expires_at   timestamptz,
  refresh_token             text not null,
  refresh_token_expires_at  timestamptz,
  scopes                    text[] not null default '{}',
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (environment, seller)
);

comment on table ebay_tokens is
  'eBay OAuth user tokens. Service role only. Never return these columns from an API route.';

-- ------------------------------------------------------------------ oauth state
-- CSRF guard for /api/ebay/oauth/callback. /oauth/start stores the SHA-256 of
-- a random state; the callback must present a state whose hash exists, is
-- unexpired and unused (consumed by a conditional UPDATE, so it is single
-- use even under concurrent callbacks). Server-side rather than a cookie so
-- an x-api-key client can start the flow and hand the URL to a browser.
create table if not exists ebay_oauth_states (
  state_hash   text primary key,
  environment  text not null check (environment in ('production', 'sandbox')),
  scopes       text[] not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz
);

-- ------------------------------------------------------------------ config
-- Key/value overrides: default business policy ids and the merchant location
-- key, set via POST /api/ebay/policies. Precedence (web/lib/ebay-api/policies.ts):
-- request override > env var > this table > Account API lookup. The
-- fulfillment policy is NEVER looked up automatically.
create table if not exists ebay_config (
  environment  text not null check (environment in ('production', 'sandbox')),
  key          text not null check (key in ('fulfillment_policy_id', 'payment_policy_id',
                                            'return_policy_id', 'merchant_location_key')),
  value        text not null,
  updated_at   timestamptz not null default now(),
  primary key (environment, key)
);

-- ------------------------------------------------------------------ audit logs
-- Every price change attempt, including failures, with the reason given.
create table if not exists price_changes (
  id           bigint generated always as identity primary key,
  environment  text not null check (environment in ('production', 'sandbox')),
  offer_id     text,
  sku          text,
  listing_id   text,
  old_price    numeric(10,2),
  new_price    numeric(10,2) not null check (new_price > 0),
  currency     text not null default 'USD',
  reason       text not null check (length(btrim(reason)) > 0),
  status       text not null check (status in ('succeeded', 'failed')),
  http_status  int,
  error        text,
  actor        text not null,
  created_at   timestamptz not null default now()
);

create index if not exists price_changes_recent on price_changes (created_at desc);
create index if not exists price_changes_offer on price_changes (offer_id, created_at desc);

-- Lifecycle actions on a listing other than a price change (today: `end`,
-- i.e. withdraw offer). Separate table so price_changes keeps a NOT NULL
-- new_price instead of a column that is meaningless for half its rows.
create table if not exists listing_events (
  id           bigint generated always as identity primary key,
  environment  text not null check (environment in ('production', 'sandbox')),
  action       text not null check (action in ('end')),
  offer_id     text,
  sku          text,
  listing_id   text,
  reason       text not null check (length(btrim(reason)) > 0),
  status       text not null check (status in ('succeeded', 'failed')),
  http_status  int,
  error        text,
  actor        text not null,
  created_at   timestamptz not null default now()
);

create index if not exists listing_events_recent on listing_events (created_at desc);

-- ------------------------------------------------------------------ listing links
-- What the CDP import created on eBay, and which tracked card it is. Written
-- after each import (card_id resolved from cards.sku for the owner, null when
-- the card is not tracked — cards stay opt-in, the import never creates one).
-- The sync uses it as its second matching rule, after cards.sku.
-- `price` mirrors the last price set through this service; eBay is the truth.
create table if not exists ebay_listings (
  id           bigint generated always as identity primary key,
  environment  text not null check (environment in ('production', 'sandbox')),
  sku          text not null,
  offer_id     text,
  listing_id   text,
  card_id      bigint references cards (id) on delete set null,
  title        text,
  price        numeric(10,2),
  status       text not null default 'unpublished'
               check (status in ('unpublished', 'published', 'ended')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (environment, sku)
);

create index if not exists ebay_listings_listing on ebay_listings (environment, listing_id) where listing_id is not null;
create index if not exists ebay_listings_offer   on ebay_listings (environment, offer_id)   where offer_id is not null;
create index if not exists ebay_listings_card    on ebay_listings (card_id)                 where card_id is not null;

-- ------------------------------------------------------------------ sync
-- Idempotency and audit for the sold-order sync: one row per (order, line).
--   closed          card closed by the sync against transaction_id
--   already_closed  card was already closed against transaction_id (usually
--                   by the importer's own SKU link)
--   pending_ledger  card matched, sale row not imported yet; retried each run
--   needs_review    ambiguous / no tracked card / conflict / refunded after
--                   close. Terminal; resolve by hand.
--   ignored         cancelled or refunded before it was matched
-- A transient error writes no row, so the next run retries that line.
-- line_price is what the Fulfillment API reported, kept for context. It is
-- NOT a ledger figure and must never be summed into any P&L.
create table if not exists ebay_synced_orders (
  id                bigint generated always as identity primary key,
  environment       text not null check (environment in ('production', 'sandbox')),
  order_id          text not null,
  line_item_id      text not null,
  status            text not null check (status in
                      ('closed', 'already_closed', 'pending_ledger', 'needs_review', 'ignored')),
  legacy_item_id    text,
  sku               text,
  title             text,
  quantity          int not null default 1,
  line_price        numeric(10,2),
  sold_at           timestamptz,
  order_line_count  int not null default 1,
  card_id           bigint references cards (id) on delete set null,
  transaction_id    bigint references transactions (id) on delete set null,
  match_type        text check (match_type in ('sku', 'listing', 'alias', 'fuzzy', 'ledger')),
  match_score       real,
  reason            text,
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (environment, order_id, line_item_id)
);

comment on column ebay_synced_orders.line_price is
  'Informational only, from the Fulfillment API. Not a ledger amount; never sum into P&L.';

create index if not exists ebay_synced_orders_pending
  on ebay_synced_orders (environment) where status = 'pending_ledger';
create index if not exists ebay_synced_orders_review
  on ebay_synced_orders (environment, updated_at desc) where status = 'needs_review';

-- Cursor for the cron, compared against order lastModifiedDate. `cursor_at`
-- only advances when a run finishes with no errors; each fetch overlaps the
-- previous cursor by an hour, and the idempotency table makes the overlap free.
create table if not exists ebay_sync_state (
  environment  text not null check (environment in ('production', 'sandbox')),
  name         text not null,
  cursor_at    timestamptz,
  last_run_at  timestamptz,
  last_status  text,
  last_error   text,
  updated_at   timestamptz not null default now(),
  primary key (environment, name)
);

-- ------------------------------------------------------------------ functions
-- The ledger functions (find_cards, sell_card) scope every query to
-- auth.uid(), which is NULL for the service role — they would see nothing.
-- These two are the sync's server-side entry points. Neither is SECURITY
-- DEFINER: they run as the caller, and only service_role may call them.

-- find_cards(), unchanged, for a named owner. Sets the JWT `sub` claim for
-- this transaction only, so auth.uid() resolves to p_user_id inside
-- find_cards. Reusing find_cards (rather than copying its body) keeps one
-- definition of "which cards match a phrase" — 008's thresholds included.
-- Relies on Supabase's auth.uid() reading request.jwt.claim.sub first;
-- verify after applying:  select * from ebay_find_cards('<owner uuid>', 'jordan');
create or replace function ebay_find_cards(p_user_id uuid, q text)
returns table (
  id bigint, sku text, title text, year text, set_name text,
  parallel text, grader text, grade text, status card_status,
  acquisition_cost numeric, acquired_on date,
  matched_alias text, match_type text, score real
)
language plpgsql
volatile
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    raise exception 'ebay_find_cards: p_user_id is required';
  end if;
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  return query select * from find_cards(q);
end;
$$;

-- Close a tracked card against an EXISTING eBay sale row, atomically:
-- card -> sold, sale_transaction_id, exited_on = the sale's date; nicknames
-- retired (same as sell_card). Writes NO transaction. Re-checks everything
-- the planner checked, under a row lock, and returns instead of raising so
-- one bad line cannot abort a sync run:
--   'closed' | 'already_closed' | 'conflict: <why>'
create or replace function ebay_close_card_for_sale(p_card_id bigint, p_transaction_id bigint)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_card  cards%rowtype;
  v_txn   transactions%rowtype;
  v_other bigint;
begin
  select * into v_txn from transactions where id = p_transaction_id;
  if not found then
    return format('conflict: transaction %s not found', p_transaction_id);
  end if;
  if v_txn.type <> 'sale' or v_txn.platform <> 'ebay' then
    return format('conflict: transaction %s is not an eBay sale', p_transaction_id);
  end if;

  select * into v_card from cards where id = p_card_id for update;
  if not found then
    return format('conflict: card %s not found', p_card_id);
  end if;
  if v_card.user_id <> v_txn.user_id then
    return 'conflict: card and sale belong to different users';
  end if;
  if v_card.status in ('sold', 'traded') then
    if v_card.sale_transaction_id = p_transaction_id then
      return 'already_closed';
    end if;
    return format('conflict: card %s already left inventory (%s on %s)',
                  p_card_id, v_card.status, v_card.exited_on);
  end if;

  select c.id into v_other from cards c
   where c.sale_transaction_id = p_transaction_id and c.id <> p_card_id
   limit 1;
  if found then
    return format('conflict: sale %s is already linked to card %s', p_transaction_id, v_other);
  end if;

  update cards
     set status = 'sold', sale_transaction_id = p_transaction_id, exited_on = v_txn.occurred_on
   where id = p_card_id;

  update card_aliases
     set retired_at = now()
   where card_id = p_card_id and retired_at is null;

  return 'closed';
end;
$$;

-- ------------------------------------------------------------------ lock down
alter table ebay_tokens        enable row level security;
alter table ebay_oauth_states  enable row level security;
alter table ebay_config        enable row level security;
alter table price_changes      enable row level security;
alter table listing_events     enable row level security;
alter table ebay_listings      enable row level security;
alter table ebay_synced_orders enable row level security;
alter table ebay_sync_state    enable row level security;

revoke all on table ebay_tokens, ebay_oauth_states, ebay_config, price_changes,
  listing_events, ebay_listings, ebay_synced_orders, ebay_sync_state
  from anon, authenticated;
revoke all on table ebay_tokens, ebay_oauth_states, ebay_config, price_changes,
  listing_events, ebay_listings, ebay_synced_orders, ebay_sync_state
  from public;

-- EXECUTE is granted to PUBLIC by default on creation; revoke it from public
-- explicitly (DECISIONS: "Revoking from anon/authenticated alone was not enough").
revoke execute on function ebay_find_cards(uuid, text) from public, anon, authenticated;
revoke execute on function ebay_close_card_for_sale(bigint, bigint) from public, anon, authenticated;
grant  execute on function ebay_find_cards(uuid, text) to service_role;
grant  execute on function ebay_close_card_for_sale(bigint, bigint) to service_role;

# eBay API service

Next.js route handlers under `web/app/api/ebay/*`, deployed with the existing
Vercel project, state in the existing Supabase. Built for Yoshi (the agent
that reprices and reports) and for importing Card Dealer Pro (CDP) exports
straight into eBay listings.

> **PARTLY VERIFIED AGAINST LIVE eBAY.** The production keyset now exists.
> App-token reads (Browse, the Insights probe) were checked live on
> 2026-11-21 — see [Verified live](#verified-live). Everything that needs a
> user token (Sell, Inventory, Fulfillment, Trading) is still from eBay's
> docs and mocked tests only: read
> [Not yet verified](#not-yet-verified-against-live-ebay) before the first
> real call.

> **Before the first real listing import: create a NEW shipping (fulfillment)
> policy in Seller Hub.** The existing policy is eBay Standard Envelope, which
> is wrong for these mid-tier cards. The import never auto-selects a
> fulfillment policy, and a real (non-dry-run) import refuses until one is
> configured. See [Business policies](#business-policies).

## Contents

- [Architecture](#architecture)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [eBay developer portal](#ebay-developer-portal)
- [Connecting the eBay account](#connecting-the-ebay-account)
- [Business policies](#business-policies)
- [Endpoint reference](#endpoint-reference)
- [CDP column mapping](#cdp-column-mapping)
- [Sold-order sync](#sold-order-sync)
- [Marketplace Insights (sold comps)](#marketplace-insights-sold-comps)
- [Known limitations](#known-limitations)
- [Verified live](#verified-live)
- [Not yet verified against live eBay](#not-yet-verified-against-live-ebay)

## Architecture

```
Yoshi / curl ──x-api-key──► /api/ebay/*  (Next.js route handlers, Vercel)
Vercel Cron ──Bearer──────► /api/ebay/cron/sync
Owner's browser ──────────► /api/ebay/oauth/start ─► eBay consent ─► /api/ebay/oauth/callback
eBay ─────────────────────► /api/ebay/account-deletion
                                   │
                    web/lib/ebay-api/*   (no Next imports outside routes/context)
                                   │
              eBay REST (Sell Inventory / Account / Fulfillment, Buy Browse /
              Marketplace Insights), legacy Trading API (XML), Supabase (service role)
```

`web/lib/ebay-api/` is modular so it can be lifted into its own service later
(see docs/DECISIONS.md, "The eBay API lives in this repo, for now"):

| module | job |
|---|---|
| `config.ts` | env, scopes, endpoints (read lazily — the build needs no secrets) |
| `auth.ts`, `respond.ts`, `errors.ts` | x-api-key / cron auth, JSON error shape, eBay error mapping |
| `http.ts` | the one REST client (`EbayRest`); tokens attached here only |
| `oauth.ts`, `tokens.ts` | consent URL, code exchange, refresh (single-flight), app token |
| `store.ts` | Supabase implementations of the storage interfaces |
| `cdp/mapping.ts` | **the** CDP column mapping (one isolated module) |
| `cdp/conditions.ts` | graded/ungraded condition descriptors (editable ID tables) |
| `cdp/payloads.ts`, `cdp/import.ts` | eBay payload building; dry-run / bulk import |
| `inventory.ts`, `offers.ts`, `policies.ts` | Inventory + Account API |
| `price.ts` | audited price change / end listing |
| `listings.ts`, `trading.ts` | active listings (Inventory + legacy Trading fallback) |
| `fulfillment.ts` | orders |
| `browse.ts`, `insights.ts`, `comps.ts` | comps |
| `sync/` | sold-order sync: `plan.ts` (pure), `run.ts`, `supabase-repo.ts` |
| `account-deletion.ts` | eBay Marketplace Account Deletion challenge |

**Auth model.** `proxy.ts` gates the dashboard behind Supabase login but
excludes `/api/ebay/*`; each route authenticates itself:

| route | auth |
|---|---|
| everything below unless listed | `x-api-key: $SHOTIME_API_KEY` (constant-time compare of SHA-256 digests; **503** if the env var is unset — fails closed) |
| `GET /api/ebay/oauth/start` | signed-in Supabase session (browser → 302) **or** valid `x-api-key` (→ JSON with the URL) |
| `GET /api/ebay/oauth/callback` | the OAuth `state`: SHA-256 stored server-side in `ebay_oauth_states`, 10-minute expiry, consumed by a conditional UPDATE so it works exactly once |
| `GET /api/ebay/cron/sync` | `Authorization: Bearer $CRON_SECRET` (what Vercel Cron sends) |
| `/api/ebay/account-deletion` | eBay's hash challenge; the POST has no side effects |

The routes use the Supabase **service-role** key (`web/lib/supabase/admin.ts`,
`import "server-only"`) because the 024 tables are RLS-locked with no
policies. The dashboard itself still uses only the anon key.

## Setup

1. **Migration.** Open the Supabase SQL editor and run
   `schema/024_ebay_api.sql`. It is idempotent. Then check the fuzzy-match
   wrapper resolves the owner (it relies on Supabase's `auth.uid()` reading
   `request.jwt.claim.sub`):
   ```sql
   select id, title, match_type from ebay_find_cards('<OWNER_USER_ID>', 'jordan');
   ```
   It should list the same cards `find_cards('jordan')` lists when signed in.
2. **eBay keyset + RuName** — see [eBay developer portal](#ebay-developer-portal).
3. **Vercel env** — set the [environment variables](#environment-variables)
   (Production, and Preview if you test there). Generate the two secrets with
   `openssl rand -hex 32`.
4. **Deploy**, then [connect the eBay account](#connecting-the-ebay-account).
5. **Create the new shipping policy** in Seller Hub, then
   `GET /api/ebay/policies` and `POST /api/ebay/policies` to save defaults.
6. *(Optional)* **Probe** Marketplace Insights: `GET /api/ebay/insights/probe`.
   Today's keyset answers `invalid_scope`; comps don't need it.
7. **Dry-run** a CDP export, then a real import with `publish=false`, check
   Seller Hub, then `publish=true`.

Local dev: `cp web/.env.example web/.env.local`, fill in, `npm run dev`.

Tests: `cd web && npm run test` (vitest, all eBay and Supabase calls mocked;
the live suite is skipped).

Live checks: `cd web && npm run test:live` with the `EBAY_*` keyset vars in
the environment. Read-only against **production**: mints an app token, runs
the real comps code for an ungraded and a PSA 10 query, reads Browse
refinements and runs the Insights probe. No user token, no Sell / Inventory /
Fulfillment / Trading call, nothing listed, edited or ended. Prints counts and
medians, never a key or token. Source:
`web/lib/ebay-api/__tests__/live/browse.live.test.ts`.

## Environment variables

All read at request time. `web/.env.example` has the same list with comments.

| name | required | notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes | already used by the dashboard |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | dashboard; also used by oauth/start to read the session |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | **server only**. Bypasses RLS. Never `NEXT_PUBLIC_` |
| `OWNER_USER_ID` | recommended | owner's auth UUID; card/ledger reads are scoped to it. Falls back to the only auth user |
| `EBAY_CLIENT_ID` | yes | App ID |
| `EBAY_CLIENT_SECRET` | yes | Cert ID |
| `EBAY_DEV_ID` | no | stored for completeness; not sent on any call today |
| `EBAY_RUNAME` | yes | the RuName string, not a URL |
| `EBAY_ENV` | no | `production` (default) or `sandbox` |
| `EBAY_MARKETPLACE_ID` | no | default `EBAY_US` |
| `EBAY_EXTRA_SCOPES` | no | `1` to request the extra scopes on every consent |
| `EBAY_INSIGHTS_ENABLED` | no | exactly `true` to let comps call Marketplace Insights. Leave unset until the probe says `available: true` |
| `EBAY_FULFILLMENT_POLICY_ID` | for real imports | **new** shipping policy; never auto-picked |
| `EBAY_PAYMENT_POLICY_ID` | no | else ebay_config, else the account's only payment policy |
| `EBAY_RETURN_POLICY_ID` | no | likewise |
| `EBAY_MERCHANT_LOCATION_KEY` | no | else ebay_config, else the only enabled inventory location |
| `EBAY_VERIFICATION_TOKEN` | production keyset | 32–80 chars `[A-Za-z0-9_-]` |
| `EBAY_ACCOUNT_DELETION_ENDPOINT` | production keyset | exact registered URL |
| `SHOTIME_API_KEY` | yes | `x-api-key` for Yoshi |
| `CRON_SECRET` | yes | Vercel Cron bearer |
| `NEXT_PUBLIC_APP_URL` | no | not read by the code; eBay stores the callback against the RuName |

## eBay developer portal

At <https://developer.ebay.com/my/keys>:

1. **Create a Production keyset** (App ID = `EBAY_CLIENT_ID`, Cert ID =
   `EBAY_CLIENT_SECRET`, Dev ID = `EBAY_DEV_ID`). A Sandbox keyset works the
   same way with `EBAY_ENV=sandbox` and a sandbox test seller.
2. **Marketplace Account Deletion.** eBay will not enable a Production keyset
   until you either subscribe to account-deletion notifications or claim an
   exemption. This service implements the endpoint:
   - set `EBAY_VERIFICATION_TOKEN` (any 32–80 char `[A-Za-z0-9_-]` string)
     and `EBAY_ACCOUNT_DELETION_ENDPOINT=https://jho-collects.vercel.app/api/ebay/account-deletion`
     in Vercel and deploy **first**;
   - in Application Keys → Notifications, enter that endpoint URL and the
     same verification token, and save. eBay sends
     `GET ?challenge_code=…`; the route answers
     `{"challengeResponse": hex(SHA-256(challenge_code + token + endpoint))}`.
   - Notifications (POST) are acknowledged with 200 and **not acted on**: this
     service holds no data keyed by eBay user id. Buyer usernames in the
     ledger come from Seller Hub reports and are tax records; whether eBay's
     policy requires purging them, or record-keeping law requires keeping
     them, is a call for Johnny (and a preparer), not code. The payload is
     never logged.
3. **User Tokens → Get a Token from eBay via Your Application → add an eBay
   Redirect URL (RuName).** Fill in:
   - *Display title*: Shotime Cards
   - *Privacy policy URL*: required by the form; any page you control that
     states how data is used
   - *Your auth accepted URL*: `https://jho-collects.vercel.app/api/ebay/oauth/callback`
   - *Your auth declined URL*: `https://jho-collects.vercel.app/api/ebay/oauth/callback`
     (the same URL). eBay's decline redirect carries **no `code`** (possibly
     `state`, possibly `error=access_denied`); the callback treats any
     request without a code as a decline: a friendly "nothing was saved"
     page, no database or eBay call, the unused state just expires. An old
     `?declined=1` URL still works.
   - choose **OAuth** (not Auth'n'Auth)

   Copy the RuName string (looks like `Johnny_Ho-JohnnyHo-Shotim-abcdefg`)
   into `EBAY_RUNAME`.
4. **Marketplace Insights** (optional) — see
   [Marketplace Insights](#marketplace-insights-sold-comps).

### Scopes

Requested on consent (space separated):

```
https://api.ebay.com/oauth/api_scope
https://api.ebay.com/oauth/api_scope/sell.inventory
https://api.ebay.com/oauth/api_scope/sell.account
https://api.ebay.com/oauth/api_scope/sell.fulfillment
```

Optional, only with `/oauth/start?extra_scopes=1` or `EBAY_EXTRA_SCOPES=1`
(asking for a scope the keyset lacks makes eBay reject the whole consent with
`invalid_scope`):

```
https://api.ebay.com/oauth/api_scope/commerce.catalog.readonly
https://api.ebay.com/oauth/api_scope/buy.marketplace.insights
```

`buy.marketplace.insights` is documented by eBay as an **application**
(client-credentials) scope, which is how this service uses it (see
`insights.ts`). Verified live: this keyset's client-credentials request for
it returns 400 `invalid_scope`, so do **not** set `EBAY_EXTRA_SCOPES` — the
whole consent would fail. Whether it can also be granted on a user token is
unclear; it is listed as an extra only so a keyset that does carry it can opt
in. `commerce.catalog.readonly` is requested for future catalog lookups; no
code uses it yet. Browse uses an app token with only the base scope.

## Connecting the eBay account

1. Sign in to the dashboard, then visit
   `https://jho-collects.vercel.app/api/ebay/oauth/start`. You are redirected
   to eBay; approve; you land on a page saying "eBay connected".
   (Machine alternative: `curl -H "x-api-key: $KEY" …/oauth/start` returns
   `{"authorization_url": …}` to open in a browser within 10 minutes.)
2. Check: `curl -H "x-api-key: $KEY" https://jho-collects.vercel.app/api/ebay/oauth/status`.

The refresh token lasts ~18 months (`refresh_token_expires_at`).
`/oauth/status` sets `warning` once fewer than 30 days remain — reconnect the
same way before then. Access tokens (~2h) refresh automatically within 2
minutes of expiry; concurrent requests in one instance share a single refresh.

## Business policies

Every offer needs a fulfillment (shipping), payment and return policy plus a
merchant location. Resolution order per value:

**request override → env var → `ebay_config` (POST /api/ebay/policies) → eBay lookup**

- **Fulfillment is never looked up.** CDP's export carries eBay Standard
  Envelope shipping, which will not be used for these cards, and the CSV's
  shipping/return/payment/location columns are ignored entirely (reported in
  the dry run as `ignoredColumns`). Create a new shipping policy in Seller Hub
  (Account → Business policies), then set it.
- Payment, return and location are looked up via the Account / Inventory API
  only if exactly one exists; zero or several is a clear error listing them.
- `GET /api/ebay/policies` lists them; fulfillment policies carry
  `shippingServices` and `looksLikeStandardEnvelope` so the eSE one is obvious.

## Endpoint reference

Base URL `https://jho-collects.vercel.app`. All responses are JSON with
`cache-control: no-store`. Errors always look like:

```json
{ "error": { "code": "invalid_price", "message": "price must be a positive number with at most 2 decimal places", "details": { "price": "1.234" } } }
```

eBay failures map to: 401 → **502** `ebay_auth_failed` (our token, not your
key), 403 → 403 `ebay_forbidden`, 404 → 404, 409 → 409, 429 → 429, 5xx → 502,
other 4xx → 400 `ebay_bad_request`. `details.ebay_errors` carries eBay's own
error ids and messages — never tokens. No connected account → 503
`ebay_not_connected`; revoked/expired refresh token → 503
`ebay_reauth_required`; missing env → 503 `misconfigured`.

```bash
export KEY=...   # SHOTIME_API_KEY
export B=https://jho-collects.vercel.app/api/ebay
```

### GET /oauth/status

```bash
curl -H "x-api-key: $KEY" $B/oauth/status
```
```json
{ "environment": "production", "marketplace_id": "EBAY_US", "connected": true,
  "scopes": ["https://api.ebay.com/oauth/api_scope", "…/sell.inventory", "…/sell.account", "…/sell.fulfillment"],
  "access_token_expires_at": "2026-11-21T16:00:00.000Z", "access_token_valid": true,
  "refresh_token_expires_at": "2028-05-21T14:00:00.000Z", "refresh_token_days_left": 547, "warning": null }
```

### GET /listings

`source=all|inventory|trading` (default all), `status=active|unpublished|all`
(default active), `limit` (1–500, default 50), `offset`.

```bash
curl -H "x-api-key: $KEY" "$B/listings?source=all&limit=20"
```
```json
{ "source": "all", "status": "active", "total": 2, "limit": 20, "offset": 0,
  "listings": [
    { "sources": ["inventory", "trading"], "listing_id": "3550001", "offer_id": "11", "sku": "204-19tvfb",
      "title": "2025 Donruss #347 Graham Mertz …", "price": "1.25", "currency": "USD",
      "quantity_available": 1, "status": "ACTIVE", "url": "https://www.ebay.com/itm/3550001" },
    { "sources": ["trading"], "listing_id": "3550099", "offer_id": null, "sku": null, "title": "Made in CDP",
      "price": "40.00", "currency": "USD", "quantity_available": 1, "status": "ACTIVE", "url": "…" } ],
  "note": "The Inventory API only returns listings created through it; …" }
```

A listing with `offer_id: null` was not created through the Inventory API, so
it cannot be repriced or ended through this service (see limitations).

### POST /listings/{id}/price

`{id}` is the **offerId** by default; add `?by=sku` to pass the SKU (must have
exactly one offer on the marketplace, else 409 `ambiguous_sku`). Optional
`x-actor: yoshi` header names the caller in the log.

```bash
curl -X POST -H "x-api-key: $KEY" -H "x-actor: yoshi" -H "content-type: application/json" \
  -d '{"price": 12.5, "reason": "3 lower BINs listed this week"}' $B/listings/11/price
```
```json
{ "status": "succeeded", "offer_id": "11", "sku": "204-19tvfb", "listing_id": "3550001",
  "old_price": "1.25", "new_price": "12.50", "currency": "USD", "reason": "3 lower BINs listed this week",
  "audit_logged": true }
```

`price`: positive, ≤ 2 decimals, number or string. `reason`: required, ≤ 500
chars. Uses `bulk_update_price_quantity` (not `PUT /offer`, which replaces
the whole offer). Every attempt that reaches eBay — success **or** failure,
with HTTP status and error — is written to `price_changes`. Requests rejected
by validation are not logged (nothing was attempted).

### POST /listings/{id}/end

```bash
curl -X POST -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"reason": "sold at the Pasadena show"}' $B/listings/11/end
```
```json
{ "status": "succeeded", "action": "end", "offer_id": "11", "sku": "204-19tvfb", "listing_id": "3550001",
  "reason": "sold at the Pasadena show", "audit_logged": true }
```

Withdraws the offer (`POST /offer/{offerId}/withdraw`): the listing ends, the
offer and inventory item stay so it can be republished. Logged to
`listing_events` (a separate table so `price_changes.new_price` can stay NOT
NULL).

### GET /price-changes

`limit` (default 50), optional `offer_id`. Newest first.

```json
{ "price_changes": [ { "id": 7, "offer_id": "11", "sku": "204-19tvfb", "listing_id": "3550001",
  "old_price": "1.25", "new_price": "12.50", "currency": "USD", "reason": "…", "status": "succeeded",
  "http_status": 200, "error": null, "actor": "api:yoshi", "created_at": "…" } ] }
```

### GET /comps

`q` (required), `grader`, `grade`, `graded=true|false`, `category_id`
(default 261328), `limit` (1–200, default 50), `exclude_outliers` (default
true), `insights=0` (skip Marketplace Insights for one request; only
meaningful when `EBAY_INSIGHTS_ENABLED=true`).

Two signals:

- **Active** — Browse asking prices of fixed-price listings (app token). This
  is market data and always present.
- **Sold** — the primary, supported source is **your own eBay sales** over
  the last 90 days whose titles contain every query word
  (`sold_comps.primary_source: "own_sales"`, data under `fallback`; the key
  name predates this and is kept so callers don't break). It is a thin,
  biased sample and labelled as such. It needs the connected user token;
  until the account is connected, `fallback.error` says so and the response
  still returns.
- **Marketplace Insights** (market sold prices) is an optional upgrade, off
  by default — see [Marketplace Insights](#marketplace-insights-sold-comps).
  While off, comps mint no insights token and make no insights call.

```bash
curl -H "x-api-key: $KEY" "$B/comps?q=shohei+ohtani+2018+topps+update&grader=PSA&grade=10"
```
```json
{ "query": { "q": "shohei ohtani 2018 topps update", "category_id": "261328", "grader": "PSA", "grade": "10",
             "graded": true, "limit": 50, "exclude_outliers": true },
  "active": { "source": "browse", "total": 41,
              "stats": { "count": 38, "min": 140, "max": 260, "mean": 189.4, "median": 185, "p25": 170, "p75": 205, "outliers_excluded": 3 },
              "items": [ { "itemId": "v1|…|0", "title": "…", "price": "185.00", "currency": "USD", "shipping": "5.00",
                           "condition": "Graded", "url": "…" } ] },
  "sold_comps": { "available": false,
                  "reason": "marketplace_insights_not_enabled",
                  "primary_source": "own_sales",
                  "fallback": { "source": "own_sales", "days": 90,
                                "note": "Your own eBay sales whose titles contain every query word. A small sample, not market data.",
                                "stats": { "count": 1, "median": 180, "…": "…" },
                                "items": [ { "order_id": "07-…", "sold_at": "…", "title": "…", "sku": "…", "quantity": 1, "unit_price": "180.00" } ] } } }
```

`sold_comps.reason` (when `available: false`):

| reason | meaning |
|---|---|
| `marketplace_insights_not_enabled` | `EBAY_INSIGHTS_ENABLED` is not `true` (the default), or `?insights=0`. Nothing was asked of eBay |
| `marketplace_insights_denied` | flag on, eBay refused: `invalid_scope` on the token, or 401/403 on the call. `detail` has eBay's message |
| `marketplace_insights_failed` | flag on, some other eBay error (5xx, timeout…). `detail` has the message |

When Marketplace Insights is enabled and answers: `"sold_comps": {"available":
true, "source": "marketplace_insights", "primary_source":
"marketplace_insights", "stats": {…}, "items": [{"itemId", "title", "price",
"currency", "soldDate", "quantitySold", "url"}]}`.

Active comps are item price only (shipping reported, not included). Graded
searches use `conditionIds:{2750}` (ungraded `{4000}`) plus `aspect_filter`
`Professional Grader:{<full name>}` / `Grade:{<value>}` — names, values and
the filters all [verified live](#verified-live). `grader` accepts the
abbreviation or full name (PSA, BGS, SGC, CGC, CSG, TAG, BCCG, BVG, KSA, GMA,
HGA, ISA, GSG, PGS, MNT, Rare, RCG, CGA, TCG); `grade` is 1–10 in half steps
or `Authentic` / `Authentic Altered` / `Authentic - Trimmed`. **Anything else
is a 400**: eBay silently ignores an aspect value it doesn't recognise and
returns unfiltered results (raw `PSA` gave 2,294 Jordan results, the full name
79), so the service refuses rather than return quietly wrong comps. Browse
results are cached 5 minutes per server instance.

### GET /insights/probe

```bash
curl -H "x-api-key: $KEY" $B/insights/probe
```
```json
{ "available": false, "status": 400,
  "reason": "keyset is not granted the buy.marketplace.insights scope (invalid_scope)",
  "scopeGranted": false, "userTokenHasScope": null }
```

That is the real answer for the production keyset (2026-11-21). The probe
ignores `EBAY_INSIGHTS_ENABLED`, so it always works for re-testing.

### GET /sales

`days` (1–365, default 30): orders **created** in the window.

```json
{ "days": 30, "since": "…", "count": 1,
  "orders": [ { "order_id": "07-15112-65577", "created_at": "…", "buyer_username": "…",
    "payment_status": "PAID", "fulfillment_status": "FULFILLED", "cancel_state": "NONE_REQUESTED", "currency": "USD",
    "totals": { "subtotal": "10.00", "delivery": "0.78", "tax": "0.95", "total": "11.73", "total_due_seller": "…", "marketplace_fee": "1.73" },
    "line_items": [ { "line_item_id": "…", "title": "…", "sku": "204-19tvfb", "legacy_item_id": "3550001",
                      "quantity": 1, "price": "10.00", "ebay_collected_tax": "0.95", "refunded": false } ] } ],
  "note": "marketplace_fee is eBay's own order-level figure when the API returns it (else null); it is never estimated." }
```

Informational. The ledger's eBay figures (fees, labels, net cash) come only
from the Seller Hub transaction report.

### POST /import-cdp

Body: `multipart/form-data` with a `file` field, or the raw CSV as
`text/csv`. Max 4 MB. Parameters (query string or form fields):

| param | default | |
|---|---|---|
| `dry_run` | **true** | only `dry_run=false` sends anything to eBay |
| `publish` | false | false = inventory items + unpublished offers; true = also publish |
| `fulfillment_policy_id`, `payment_policy_id`, `return_policy_id`, `merchant_location_key` | — | per-request overrides |

```bash
# dry run: parse, map, validate, show the exact payloads; no eBay calls, no DB writes
curl -X POST -H "x-api-key: $KEY" -F file=@cdp_export.csv $B/import-cdp

# create + publish with a specific shipping policy
curl -X POST -H "x-api-key: $KEY" -F file=@cdp_export.csv \
  "$B/import-cdp?dry_run=false&publish=true&fulfillment_policy_id=6200000000"
```
```json
{ "dry_run": true, "publish": false,
  "summary": { "rows": 8, "ready": 7, "invalid": 0, "skipped_zero_quantity": 1, "inventory_failed": 0,
               "offer_failed": 0, "offer_created": 0, "publish_failed": 0, "published": 0 },
  "columns": { "mapped": { "action": "*Action(SiteID=US|…)", "sku": "CustomLabel", "title": "*Title", "price": "*StartPrice", "…": "…" },
               "aspects": ["Graded", "Sport", "Player/Athlete", "…"],
               "descriptors": [ { "name": "Grade", "id": "27502", "freeText": false }, "…" ],
               "ignoredColumns": ["*Location", "PostalCode", "ShippingType", "ShippingService-1:Option", "…"],
               "unmappedColumns": ["StoreCategory", "Subtitle", "Relationship", "GalleryType", "BuyItNowPrice", "ScheduleTime"] },
  "policies": { "fulfillmentPolicyId": null, "paymentPolicyId": null, "returnPolicyId": null, "merchantLocationKey": null,
                "sources": { "fulfillmentPolicyId": "unset", "…": "…" },
                "problems": ["No fulfillment (shipping) policy configured. Create a new shipping policy …"] },
  "rows": [
    { "line": 3, "sku": "203-19tvfa", "title": "2025 Donruss #BS-EEA Emeka Egbuka Bomb Squad", "status": "skipped_zero_quantity",
      "errors": [], "warnings": ["Quantity is 0: the Inventory API cannot publish it; row skipped (not sent to eBay)"],
      "payloads": { "inventoryItem": { "…": "…" }, "offer": { "…": "…" } } },
    { "line": 4, "sku": "204-19tvfb", "status": "ready", "errors": [], "warnings": [],
      "payloads": {
        "inventoryItem": { "sku": "204-19tvfb", "locale": "en_US",
          "product": { "title": "2025 Donruss #347 Graham Mertz Optic Rated Rookies Preview Pink", "description": "<p>…</p>",
                       "aspects": { "Graded": ["No"], "Sport": ["Football"], "Player/Athlete": ["Graham Mertz"], "Features": ["RC"], "…": ["…"] },
                       "imageUrls": ["https://…-front.jpg", "https://…-back.jpg"] },
          "condition": "USED_VERY_GOOD", "conditionDescriptors": [ { "name": "40001", "values": ["400010"] } ],
          "availability": { "shipToLocationAvailability": { "quantity": 1 } } },
        "offer": { "sku": "204-19tvfb", "marketplaceId": "EBAY_US", "format": "FIXED_PRICE", "availableQuantity": 1,
          "categoryId": "261328", "listingDescription": "<p>…</p>", "listingDuration": "GTC",
          "pricingSummary": { "price": { "value": "1.25", "currency": "USD" } },
          "listingPolicies": { "fulfillmentPolicyId": null, "paymentPolicyId": null, "returnPolicyId": null,
                               "bestOfferTerms": { "bestOfferEnabled": true } },
          "merchantLocationKey": null } } } ],
  "warnings": [] }
```

Real runs: inventory items (`bulk_create_or_replace_inventory_item`) → offers
(`bulk_create_offer`) → optionally `bulk_publish_offer`, 25 per call, per-row
`status` / `errors` / `offerId` / `listingId`. A failed chunk fails only its
rows; auth/rate-limit errors stop the run. An existing offer for a SKU is
reported with its `offerId` (reprice it instead). Without a fulfillment policy
a real run returns **422 `policies_unresolved`** and sends nothing. Afterwards
each SKU's offer/listing is written to `ebay_listings` with `card_id` when a
tracked card has that SKU (the import never creates card rows).

### GET / POST /policies

```bash
curl -H "x-api-key: $KEY" $B/policies
curl -X POST -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"fulfillment_policy_id": "6200000000", "payment_policy_id": "6100000000", "return_policy_id": "6300000000", "merchant_location_key": "home"}' \
  $B/policies
```

GET returns `fulfillment_policies`, `payment_policies`, `return_policies`
(each `{id, name, isDefault, …}`; fulfillment adds `shippingServices`,
`looksLikeStandardEnvelope`), `locations`, and `defaults` (what an import would
use now). POST checks each id exists on the account, then saves to
`ebay_config`: `{"saved": {"fulfillment_policy_id": "…"}}`.

### POST /sync, GET /sync, GET /cron/sync

```bash
curl -X POST -H "x-api-key: $KEY" "$B/sync"                     # dry run (default): returns the plan
curl -X POST -H "x-api-key: $KEY" "$B/sync?dry_run=false"       # apply
curl -X POST -H "x-api-key: $KEY" "$B/sync?dry_run=false&since=2026-10-01T00:00:00Z"   # back-fill
curl -H "x-api-key: $KEY" "$B/sync"                             # state + needs_review list
```
```json
{ "dry_run": true, "since": "2026-11-20T14:00:00.000Z", "run_at": "…", "orders_fetched": 3, "lines": 4,
  "counts": { "closed": 1, "pending_ledger": 1, "needs_review": 1, "noop": 1 },
  "cursor_advanced": false,
  "fuzzy_matches": [],
  "decisions": [
    { "order_id": "07-…", "line_item_id": "…", "title": "…", "sku": "204-19tvfb", "action": "close", "status": "closed",
      "reason": "close card 12 against transaction 345", "card_id": 12, "transaction_id": 345, "match_type": "sku", "score": null },
    { "order_id": "07-…", "line_item_id": "…", "title": "1997 Michael Jordan PSA 10", "sku": null, "action": "record",
      "status": "needs_review", "reason": "ambiguous: 2 cards match the title",
      "candidates": [ { "id": 3, "title": "michael jordan psa 10", "score": 0.81 }, { "id": 9, "title": "michael jordan psa 10", "score": 0.81 } ],
      "card_id": null, "transaction_id": 346, "match_type": null, "score": null } ],
  "errors": [] }
```

`/cron/sync` (Vercel, `Authorization: Bearer $CRON_SECRET`) runs the same
thing for real and returns counts only.

### /account-deletion

`GET ?challenge_code=X` → `{"challengeResponse": "<sha256 hex>"}`; `POST` → 200.

## CDP column mapping

`web/lib/ebay-api/cdp/mapping.ts` is the only place that knows CDP's columns.
It was built from a real CDP export (de-identified copy:
`web/lib/ebay-api/__tests__/fixtures/cdp_sample.csv`), which is eBay **File
Exchange** format:

- Row 1 `Info,Version=1.0.0,Template=fx_category_template_EBAY_US,…` is skipped.
- Row 2 is the header. Markers are parsed generically: `*` = required by FX,
  `C:Name` = item specific → `product.aspects`, `CD:Name - (ID: n)` =
  condition descriptor whose value is a value ID, `CDA:Name - (ID: n)` =
  descriptor with free text (`additionalInfo`). `*Action(…)` matches by prefix.
- Plain columns map through `FIELD_ALIASES` — case- and punctuation-insensitive.

| eBay payload | from |
|---|---|
| path SKU | `CustomLabel` (aliases: SKU, Custom Label) — required |
| `product.title` | `*Title` — required, ≤ 80 chars |
| `product.description` + offer `listingDescription` | `*Description` (HTML kept) |
| `product.aspects` | every non-empty `C:` column, multi-values split on `\|`; `Graded` forced to Yes/No |
| `product.imageUrls` | `PicURL`, split on `\|` or `;`, trimmed, https only, ≥ 1 |
| `condition` + `conditionDescriptors` | `*ConditionID`, `*C:Graded`, `CD:` / `CDA:` columns — see below |
| `availability…quantity`, offer `availableQuantity` | `*Quantity` (0 → row skipped with a warning) |
| offer `pricingSummary.price` | `*StartPrice` — required |
| offer `format` / `listingDuration` | `*Format` FixedPrice → `FIXED_PRICE`; always `GTC` |
| offer `categoryId` | `*Category` (default 261328) |
| offer `listingPolicies.bestOfferTerms` | `BestOfferEnabled`, `BestOfferAutoAcceptPrice`, `MinimumBestOfferPrice` (auto-decline) |
| *(ignored, reported as `ignoredColumns`)* | `Location`, `PostalCode`, `Shipping*`, `DispatchTimeMax`, `Returns*`, `Refund*`, `PayPal*`, `ImmediatePayRequired`, `PaymentInstructions`, `*ProfileName`, `TakeBackPolicyID`, `ProductCompliancePolicyID`, … |
| *(unused, reported as `unmappedColumns`)* | `StoreCategory`, `Subtitle`, `Relationship`, `GalleryType`, `BuyItNowPrice`, `ScheduleTime` |

Missing `sku`, `title` or `price` columns → 400 `cdp_missing_columns`
listing what is missing, the accepted header names, and every unmapped header.

**To adjust:** add a header alias to `FIELD_ALIASES`; add a prefix to
`IGNORED_PREFIXES` to stop a column being read. New `C:` aspects need no code.

### Condition descriptors (`cdp/conditions.ts`)

| | conditionId | Inventory `condition` | descriptors |
|---|---|---|---|
| Ungraded | 4000 | `USED_VERY_GOOD` | `40001` Card Condition → value ID (e.g. `400010` Near Mint or Better) |
| Graded | 2750 | `LIKE_NEW` | `27501` Professional Grader → value ID; `27502` Grade → value ID; `27503` Certification Number → `additionalInfo` (≤ 30 chars) |

Already-numeric value IDs in the CSV pass through untouched. Names are looked
up in `GRADER_IDS` (PSA, BGS, SGC, CGC, TAG, …), `GRADE_IDS` (10, 9.5, …,
Authentic) and `CARD_CONDITION_IDS`. **An unknown grader or grade fails that
row** with a message saying which table to edit; nothing is guessed.

**Only `400010` is confirmed** (it is in the real export). The 2750/4000 →
enum mapping and every other value ID are from eBay's docs and unverified.

## Sold-order sync

**What it does:** links sold eBay lines to tracked cards and closes them.
**What it never does:** write a `transactions` row. Full rationale in
docs/DECISIONS.md ("The eBay API sync never writes ledger cash rows").

- Cash, fees and labels come only from the transaction-report importers
  (`importers/load_ebay.py`, the dashboard's `/data` eBay tab). Unchanged.
- Shared key: `transactions.order_ref` = Fulfillment `orderId`,
  `transactions.item_number` = `legacyItemId`.
- Card matching, first hit wins: `cards.sku` = line SKU → `ebay_listings`
  link by listing id/SKU → `find_cards(title)` only when exactly one candidate
  survives (candidates whose own SKU contradicts the sold SKU are dropped).
  Anything else is `needs_review`, never a guess.
- If the report has not been imported yet, a matched card waits as
  `pending_ledger` (a card cannot be `sold` without a sale row) and closes on
  the first sync after the import. Whichever runs first, nothing is counted
  twice — the importer's own SKU close and the sync's close both refuse an
  already-closed card.
- Cancelled / fully refunded / refunded lines → `ignored`; unpaid → deferred;
  a refund after a close → `needs_review` ("card may be back in hand").
- Idempotent: `ebay_synced_orders` unique on (environment, order, line);
  a re-run writes nothing.
- Cursor: `ebay_sync_state.cursor_at` vs order **lastModifiedDate** (so
  payments/cancellations/refunds after the sale are seen), 1-hour overlap,
  advances only after an error-free run. First run looks back 30 days.
- `needs_review` with reason `no_card_match` is normal for bulk commons sold
  without a card row — cards are opt-in.

**Cron:** `web/vercel.json` runs `/api/ebay/cron/sync` daily at 15:00 UTC
(7–8am Pacific). **Vercel Hobby allows only daily crons and fires anywhere
within the scheduled hour**; that is fine here because the sync only closes
cards against report rows, which arrive weekly. On Pro, a tighter schedule
(e.g. `0 * * * *`) needs only a vercel.json change. A manual
`POST /api/ebay/sync?dry_run=false` works any time.

## Marketplace Insights (sold comps)

Restricted API; most sellers do not have it, and **this keyset does not**:
the probe returns 400 `invalid_scope` (the keyset is not entitled to the
`buy.marketplace.insights` scope at all). So it is an opt-in upgrade, off by
default, and the documented sold signal is your own sales (see
[GET /comps](#get-comps)).

To get it later:

1. **Request access**: developer.ebay.com → Application Keys → the
   production keyset → request access to **Marketplace Insights** (a Buy
   API). The form's exact name and location in the portal are not verified
   here; eBay asks for the use case, and approval is discretionary and can
   take weeks.
2. **Re-test** — no env change needed, the probe ignores the flag:
   `curl -H "x-api-key: $KEY" $B/insights/probe`, or locally
   `cd web && npm run test:live` (its probe check *expects* `invalid_scope`
   and will fail once access is granted — that failure is the good news;
   update the assertion).
   - `scopeGranted: false`, `status: 400` (`invalid_scope`) → still no
     entitlement. Today's answer.
   - `scopeGranted: true`, `status: 403` → scope granted, API access not.
   - `available: true` → go to step 3.
3. **Enable**: set `EBAY_INSIGHTS_ENABLED=true` in Vercel and redeploy.
   Comps then report `sold_comps.available: true`, `primary_source:
   "marketplace_insights"`; `?insights=0` skips it per request. If the call
   later fails, comps fall back to own sales with
   `marketplace_insights_denied` / `_failed`. (If eBay grants it as a user
   scope instead, reconnect with `/oauth/start?extra_scopes=1`.)

## Known limitations

- **Inventory API vs. CDP/Seller Hub listings.** The Inventory API sees only
  listings created through it (this service's import) or migrated with
  `bulkMigrateListing`. Listings CDP pushed itself, or made in Seller Hub,
  appear only via the Trading fallback (`source=trading`) and have no
  `offer_id`, so they cannot be repriced/ended here. Migrating them is
  possible but not built.
- **Trading API fallback** is legacy XML, parsed minimally, isolated in
  `trading.ts`. It reads ActiveList only.
- **No market sold comps** without Marketplace Insights (which this keyset
  lacks); own sales are a thin, biased sample and labelled as such, and need
  the account connected.
- **Condition descriptor IDs are unverified** except `400010`.
- **Vercel cron** is daily on Hobby and may fire late in the hour.
- **In-memory caches are per instance** (app token, Browse 5 min, policy
  lookups 5 min). Cold starts refetch; nothing correctness-critical depends
  on them. Token refresh single-flight is per instance; two instances
  refreshing at once is harmless.
- **Multi-quantity lines** go to `needs_review` (a card row is one card).
- **Account-deletion POSTs are not acted on** and eBay's signature is not
  verified (safe only because the POST has no effect).
- `price_changes` only covers changes made through this service.
- The report importers' SKU close does not retire nicknames;
  `ebay_close_card_for_sale` does (like `sell_card`). Pre-existing gap,
  untouched here.

## Verified live

Checked against **production** on 2026-11-21 with the real keyset, app token
only (`npm run test:live`, plus ad-hoc read-only Browse calls):

- **Client-credentials app token** with the base `api_scope`: 200, through the
  real `getAppToken` code path.
- **Marketplace Insights scope**: 400 `invalid_scope` on the token request;
  `probeInsights` reports `available: false, status: 400, scopeGranted:
  false`. The keyset is not entitled.
- **Browse `item_summary/search`** with the real `searchActive`/`getComps`:
  200, response parses, every item has a numeric `price.value`, stats
  compute. Ungraded Wembanyama Prizm: ~7,200 results, median ask ~$80;
  Jordan 1986 Fleer PSA 10: 79 results, median ask ~$300.
- **Category 261328** accepted; eBay names it *Trading Card Singles*.
- **`filter=conditionIds:{2750}` / `{4000}`** accepted; every returned item
  is `condition: "Graded"` / `"Ungraded"` respectively.
- **`aspect_filter` names** `Professional Grader` and `Grade` (from
  `refinement.aspectDistributions`), and it is **applied**: PSA + 10 cut
  graded Jordan results from 2,293 to 79.
- **Grader aspect strings**: all 19 in `GRADER_ASPECT_NAMES` (e.g.
  `Professional Sports Authenticator (PSA)`, `Beckett Grading Services (BGS)`,
  `Sportscard Guaranty Corporation (SGC)`, `Certified Guaranty Company (CGC)`,
  `Technical Authentication & Grading (TAG)`). PCA, ACE and ARK did not
  appear and are refused by comps.
- **Grade aspect values**: `1`–`10` in half steps, `Authentic`,
  `Authentic Altered`, `Authentic - Trimmed`.
- **Unknown aspect values are silently ignored** (no error, no warning,
  unfiltered results) — hence the 400 on unmapped graders/grades.

Not yet re-run live: Browse `buyingOptions:{FIXED_PRICE}` was sent on every
check above and accepted, but its effect was not separately measured.

## Not yet verified against live eBay

Everything below is from eBay's public docs (as known at writing), covered
only by mocked tests. Check each on first real use:

1. OAuth user flow: consent URL params, authorization-code and refresh token
   responses, `refresh_token_expires_in`, scope list on refresh, what exactly
   eBay appends to the declined redirect (handled either way: no `code` =
   declined).
2. Condition mapping 2750→`LIKE_NEW`, 4000→`USED_VERY_GOOD`, and all graded
   value IDs (`GRADER_IDS`, `GRADE_IDS`) and non-NM card-condition IDs. Verify
   with `GET /sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=categoryIds:{261328}`
   before the first **graded** publish.
3. Bulk endpoint request/response shapes (`responses[].statusCode/sku/offerId`),
   the 25-item limit, error 25002 carrying `offerId`, `getOffers` 404/25713 for
   a SKU with no offers.
4. `bulk_update_price_quantity` request shape for a price-only change.
5. Whether `Content-Language: en-US` is required/accepted on every write.
6. Fulfillment: `lastmodifieddate` filter format, `totalMarketplaceFee`
   presence, `lineItems[].refunds`, how far back `getOrders` reaches
   (`days` > 90 may return fewer orders than exist).
7. **That Fulfillment `orderId` equals the report's "Order number" and
   `legacyItemId` equals its "Item ID".** The sync's ledger join depends on
   it. First check: run `POST /sync` (dry run) after an import and confirm
   recent orders show `close`/`already_closed`, not `pending_ledger`.
8. Marketplace Insights path `v1_beta`, response field names, and the 403
   denial shape (unreachable without access; `invalid_scope` is verified).
9. Grader **value IDs** (`GRADER_IDS`) behind the verified aspect strings —
   the same item as 2; only the strings are verified.
10. Trading: compatibility level 1193 with IAF token, ActiveList field names,
    Ack/Errors format.
11. Account-deletion challenge hash and the portal's verification flow.

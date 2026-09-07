# web — dashboard

Next.js 16 (App Router) + Supabase. Runs locally now, deploys to Vercel later
without changes.

## Run

```bash
cd web
cp .env.local.example .env.local   # fill in the two NEXT_PUBLIC_* values
npm install
npm run dev                        # http://localhost:3000
```

Sign in with the owner account created in Phase 0 (Supabase Auth).

## How it talks to the database

- `@supabase/ssr` with the **publishable (anon) key** in every environment.
  RLS is the access model; the service key is never referenced here.
- `proxy.ts` (Next 16's rename of `middleware.ts`) refreshes the auth session
  on each request and redirects to `/login` when there is no session.
- Pages are Server Components that query the SQL **views**
  (`daily_position`, `ledger_running`, …). Those views are
  `security_invoker`, so they return only the signed-in user's rows.

## Deploy (later)

Vercel project with **Root Directory = `web`**. Set `NEXT_PUBLIC_SUPABASE_URL`
and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the Vercel env. Add the deployed origin
to Supabase Auth → URL Configuration (redirect URLs). Nothing in the code
changes.

## Built so far

- Auth (login / sign-out, route protection)
- Position cards: net cash / est. inventory value (manual, per-browser) /
  adjusted position
- Cumulative net-cash chart with a 30d / 90d / 1y / All window control. The
  series is built server-side from `transactions.net_cash`, one cumulative
  point per day from the first transaction through today (the fixed-180-day
  `daily_position` view is no longer used by the app).
- Recent-ledger table (`ledger_running`)
- Rolling windows (`dashboard_windows`, 7 / 30 / 90 / 180 / 365 day)
- Margin by price band (computed from sale rows)
- Card inventory (`cards` by status) with a `tracked_inventory` summary
- Buyer list (`buyer_summary`, filter + sort, repeat-buyer flag)
- `import_health` warning banner

## Before deploying

`package.json` pins `engines.node >= 22` (`@supabase/supabase-js` drops Node 20
support). Install Node 22 locally and set it in the Vercel project.

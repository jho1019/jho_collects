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
- Cumulative net-cash chart from `daily_position` + recent-ledger table

## Still to build (Phase 4)

Position cards (net cash / est. inventory value / adjusted), rolling windows
(`dashboard_windows`), buyer list (`buyer_summary`), card inventory
(`cards` filtered by status), margin by price band, and the `import_health`
warning banner.

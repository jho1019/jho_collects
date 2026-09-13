import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-page p-6">
      <form
        action={login}
        className="w-full max-w-sm space-y-4 rounded-lg border border-brand-soft/25 bg-surface p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold text-ink">Card ledger</h1>
          <p className="text-sm text-ink-muted">Sign in to view the dashboard.</p>
        </div>

        {error && (
          <p className="rounded bg-accent/10 px-3 py-2 text-sm text-accent-ink">
            {error}
          </p>
        )}

        <label className="block text-sm">
          <span className="text-ink-muted">Email</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className="mt-1 w-full rounded border border-brand-soft/40 px-3 py-2 text-sm text-ink"
          />
        </label>

        <label className="block text-sm">
          <span className="text-ink-muted">Password</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="mt-1 w-full rounded border border-brand-soft/40 px-3 py-2 text-sm text-ink"
          />
        </label>

        <button
          type="submit"
          className="w-full rounded bg-brand px-3 py-2 text-sm font-medium text-surface hover:opacity-90"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}

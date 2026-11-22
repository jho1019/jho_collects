import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  // G10: same fields and server action as before, no sign-up / forgot.
  // Midnight look: logo with an amber ring, a board card on the page, amber
  // "Sign in" (btn pri), errors in a neg banner.
  return (
    <main className="flex min-h-screen items-center justify-center px-3.5 py-10 sm:px-8">
      <div className="grid w-full max-w-sm gap-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo.webp"
          alt=""
          className="login-logo mx-auto aspect-square w-44 sm:w-52"
        />
        <form action={login} className="board bd grid gap-4">
          <div>
            <h1 className="num text-[32px] font-black uppercase leading-none tracking-[0.02em] text-ink">
              shotime_cards
            </h1>
            <p className="sub mt-1.5">Sign in to view the dashboard.</p>
          </div>

          {error && (
            <p className="ban err" role="alert">
              <span>{error}</span>
            </p>
          )}

          <label className="grid gap-1.5">
            <span className="bl">Email</span>
            <input
              name="email"
              type="email"
              required
              autoComplete="email"
              className="field w-full !py-2"
            />
          </label>

          <label className="grid gap-1.5">
            <span className="bl">Password</span>
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="field w-full !py-2"
            />
          </label>

          <button type="submit" className="btn pri mt-1 w-full !py-2 !text-[15px]">
            Sign in
          </button>
        </form>
      </div>
    </main>
  );
}

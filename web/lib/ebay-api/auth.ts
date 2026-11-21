import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError, ConfigError } from "./errors";
import type { Env } from "./config";

// Machine auth for /api/ebay/*. The routes are excluded from the Supabase
// login redirect in proxy.ts, so these checks are the ONLY gate — every route
// must call one of them (respond.ts's `apiRoute` does it by default).

/**
 * Constant-time string comparison. Both sides are SHA-256 hashed first so the
 * buffers are always 32 bytes: timingSafeEqual throws on unequal lengths, and
 * an early length check would leak the secret's length through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * `x-api-key` must equal SHOTIME_API_KEY. Fails closed: if the env var is
 * unset or blank, every request is refused with 503 rather than accepted.
 */
export function requireApiKey(headers: Headers, env: Env = process.env): void {
  const expected = env.SHOTIME_API_KEY?.trim();
  if (!expected) {
    throw new ConfigError("SHOTIME_API_KEY is not set; API is disabled");
  }
  const given = headers.get("x-api-key");
  if (!given || !safeEqual(given, expected)) {
    throw new ApiError(401, "unauthorized", "missing or invalid x-api-key");
  }
}

export function hasValidApiKey(headers: Headers, env: Env = process.env): boolean {
  const expected = env.SHOTIME_API_KEY?.trim();
  const given = headers.get("x-api-key");
  return Boolean(expected && given && safeEqual(given, expected));
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Fails closed. */
export function requireCronSecret(headers: Headers, env: Env = process.env): void {
  const expected = env.CRON_SECRET?.trim();
  if (!expected) {
    throw new ConfigError("CRON_SECRET is not set; cron is disabled");
  }
  const auth = headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(auth);
  if (!m || !safeEqual(m[1], expected)) {
    throw new ApiError(401, "unauthorized", "missing or invalid cron bearer token");
  }
}

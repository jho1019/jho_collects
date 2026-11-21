import type { NextRequest } from "next/server";
import { ApiError } from "./errors";
import { requireApiKey, requireCronSecret } from "./auth";

// Route plumbing shared by every /api/ebay/* handler: auth first, one JSON
// error shape, no caching. Handlers return plain data (-> 200 JSON) or a
// Response when they need a different status or content type.

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const NO_STORE = { "cache-control": "no-store" };

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    const body: ErrorBody = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
    return json(body, err.status);
  }
  // Unknown failure: log the type and message server-side, return nothing
  // specific. Never echo — it could be a Supabase internal or worse.
  console.error("[ebay-api] unhandled error:", err instanceof Error ? `${err.name}: ${err.message}` : err);
  return json({ error: { code: "internal_error", message: "internal error" } } satisfies ErrorBody, 500);
}

export type RouteAuth = "api-key" | "cron" | "none";

/**
 * Wraps a handler with auth + error rendering. `auth: "none"` is for routes
 * that do their own checks (oauth/start, oauth/callback, account-deletion)
 * and must say why at the call site.
 */
export function apiRoute<Ctx>(
  handler: (req: NextRequest, ctx: Ctx) => Promise<unknown>,
  auth: RouteAuth = "api-key",
): (req: NextRequest, ctx: Ctx) => Promise<Response> {
  return async (req, ctx) => {
    try {
      if (auth === "api-key") requireApiKey(req.headers);
      else if (auth === "cron") requireCronSecret(req.headers);
      const out = await handler(req, ctx);
      return out instanceof Response ? out : json(out);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

// ---------------------------------------------------------------- query helpers

export function intParam(
  sp: URLSearchParams, name: string, def: number, min: number, max: number,
): number {
  const raw = sp.get(name);
  if (raw === null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(400, "invalid_param", `${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function boolParam(sp: URLSearchParams, name: string, def: boolean): boolean {
  const raw = sp.get(name);
  if (raw === null || raw === "") return def;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new ApiError(400, "invalid_param", `${name} must be true or false`);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ApiError(400, "invalid_json", "request body must be a JSON object");
}

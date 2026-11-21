// One error type for everything a route can return. Routes catch ApiError and
// render it as {error:{code,message,details?}} with `status` (see respond.ts).
// Anything that is not an ApiError becomes a generic 500 — its message is
// never echoed, because it might carry a token or a Supabase internal.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A required env var or config value is missing. Surfaces as 503. */
export class ConfigError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(503, "misconfigured", message, details);
    this.name = "ConfigError";
  }
}

/** One entry of eBay's REST error envelope ({errors:[...]}) or a Trading API <Errors> node. */
export interface EbayErrorItem {
  errorId?: number;
  domain?: string;
  category?: string;
  message?: string;
  longMessage?: string;
  parameters?: { name?: string; value?: string }[];
}

/**
 * eBay answered with a non-2xx status. The upstream status is mapped to one
 * that means something to *our* caller:
 *
 *   401 -> 502 ebay_auth_failed  (our stored token is bad; the caller's
 *                                 x-api-key was fine, so not a 401 from us)
 *   403 -> 403 ebay_forbidden    (usually a missing OAuth scope / no access)
 *   404 -> 404 ebay_not_found
 *   409 -> 409 ebay_conflict
 *   429 -> 429 ebay_rate_limited
 *   5xx -> 502 ebay_upstream_error
 *   other 4xx -> 400 ebay_bad_request (validation errors from eBay)
 *
 * The message is built only from eBay's own error text — never from request
 * headers or bodies — so a token cannot leak through it.
 */
export class EbayApiError extends ApiError {
  constructor(
    public readonly upstreamStatus: number,
    public readonly ebayErrors: EbayErrorItem[],
    context: string,
  ) {
    const [status, code] = mapUpstream(upstreamStatus);
    const first = ebayErrors[0];
    const text = first?.longMessage || first?.message || `HTTP ${upstreamStatus}`;
    super(status, code, `${context}: ${text}`, {
      upstream_status: upstreamStatus,
      ebay_errors: ebayErrors.map((e) => ({
        errorId: e.errorId,
        domain: e.domain,
        category: e.category,
        message: e.message,
        longMessage: e.longMessage,
        parameters: e.parameters,
      })),
    });
    this.name = "EbayApiError";
  }
}

function mapUpstream(s: number): [number, string] {
  if (s === 401) return [502, "ebay_auth_failed"];
  if (s === 403) return [403, "ebay_forbidden"];
  if (s === 404) return [404, "ebay_not_found"];
  if (s === 409) return [409, "ebay_conflict"];
  if (s === 429) return [429, "ebay_rate_limited"];
  if (s >= 500) return [502, "ebay_upstream_error"];
  return [400, "ebay_bad_request"];
}

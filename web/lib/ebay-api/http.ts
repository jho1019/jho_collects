import { ApiError, EbayApiError, type EbayErrorItem } from "./errors";

// Thin REST client for eBay's JSON APIs. Every module that talks to eBay goes
// through `EbayRest.call`, so error mapping and token handling live in one
// place. `fetch` is injected so tests never touch the network.
//
// Tokens are attached here and nowhere else, and are never included in an
// error message, a log line or a response body.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Query = Record<string, string | number | boolean | undefined | null>;

export interface CallOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** Short human label used as the error message prefix, e.g. "publish offer". */
  context: string;
}

export interface EbayRestOptions {
  apiBase: string;
  fetch: FetchLike;
  /** Resolves a bearer token (user or app). Called once per request. */
  token: () => Promise<string>;
  marketplaceId: string;
  timeoutMs?: number;
}

export class EbayRest {
  constructor(private readonly opts: EbayRestOptions) {}

  get marketplaceId(): string {
    return this.opts.marketplaceId;
  }

  async call<T>(method: string, path: string, o: CallOptions): Promise<T> {
    const url = buildUrl(this.opts.apiBase, path, o.query);
    const token = await this.opts.token();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "x-ebay-c-marketplace-id": this.opts.marketplaceId,
      // Without this, Node's fetch sends `accept-language: *`, which eBay rejects (errorId 25709).
      "accept-language": "en-US",
      ...o.headers,
    };
    let body: string | undefined;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["content-type"] = "application/json";
      // Inventory API rejects item/offer writes without a Content-Language.
      headers["content-language"] ??= "en-US";
    }

    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 25_000),
      });
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error";
      throw new ApiError(502, "ebay_unreachable", `${o.context}: eBay ${why}`);
    }
    return parseResponse<T>(res, o.context);
  }
}

export function buildUrl(base: string, path: string, query?: Query): string {
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return `${base}${path}${qs ? `?${qs}` : ""}`;
}

/** 2xx -> parsed JSON (or undefined for an empty body). Otherwise EbayApiError. */
export async function parseResponse<T>(res: Response, context: string): Promise<T> {
  const text = await res.text();
  if (res.ok) {
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(502, "ebay_bad_response", `${context}: eBay returned non-JSON`);
    }
  }
  throw new EbayApiError(res.status, extractErrors(text), context);
}

/** Pulls eBay's error list out of a REST or OAuth error body. Never echoes raw text. */
export function extractErrors(text: string): EbayErrorItem[] {
  try {
    const j = JSON.parse(text) as {
      errors?: EbayErrorItem[];
      error?: string;
      error_description?: string;
    };
    if (Array.isArray(j.errors)) return j.errors;
    if (j.error) return [{ message: j.error, longMessage: j.error_description }];
  } catch {
    /* HTML error page or empty body: report only the status */
  }
  return [];
}

/** Every eBay amount is {value: "12.34", currency: "USD"}. */
export interface Amount {
  value: string;
  currency: string;
}

export function usd(value: string): Amount {
  return { value, currency: "USD" };
}

/** Run `fn` over `items` with at most `limit` in flight. Keeps input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

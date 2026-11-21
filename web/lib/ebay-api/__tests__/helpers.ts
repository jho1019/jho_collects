import type { EbayConfig } from "../config";
import { ENDPOINTS } from "../config";
import type { FetchLike } from "../http";

// Mocked eBay. Tests register routes as (method, url-substring) -> responder;
// any unmatched request fails the test loudly. No network, ever.

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (req: Recorded) => Response | Promise<Response>;

export function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function mockFetch() {
  const routes: { method: string; match: string; respond: Responder }[] = [];
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: Recorded = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(req);
    // Last registered wins, so a test can override a default route.
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (r.method === req.method && req.url.includes(r.match)) return r.respond(req);
    }
    throw new Error(`unmocked request: ${req.method} ${req.url}`);
  };
  return {
    fetch,
    calls,
    on(method: string, match: string, respond: Responder | unknown) {
      routes.push({
        method,
        match,
        respond: typeof respond === "function" ? (respond as Responder) : () => jsonRes(respond),
      });
      return this;
    },
  };
}

export const testConfig: EbayConfig = {
  environment: "production",
  clientId: "client-id",
  clientSecret: "client-secret",
  ruName: "Test-RuName",
  marketplaceId: "EBAY_US",
  endpoints: ENDPOINTS.production,
  extraScopesByDefault: false,
};

import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { challengeResponse, getDeletionConfig } from "../account-deletion";
import { config as proxyConfig } from "@/proxy";

const API_DIR = join(__dirname, "..", "..", "..", "app", "api", "ebay");
const KEY = "test-key-0123456789abcdef";
const TOKEN = "verification_token_0123456789_abcdefgh";
const ENDPOINT = "https://jho-collects.vercel.app/api/ebay/account-deletion";

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
}

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

beforeAll(() => {
  process.env.SHOTIME_API_KEY = KEY;
  process.env.CRON_SECRET = "cron-secret";
});
afterAll(() => {
  delete process.env.SHOTIME_API_KEY;
  delete process.env.CRON_SECRET;
  delete process.env.EBAY_VERIFICATION_TOKEN;
  delete process.env.EBAY_ACCOUNT_DELETION_ENDPOINT;
});

// Routes that deliberately do NOT use x-api-key, and what guards them instead.
const OWN_AUTH: Record<string, string> = {
  "oauth/start/route.ts": "supabase session or x-api-key",
  "oauth/callback/route.ts": "single-use server-side state",
  "account-deletion/route.ts": "eBay challenge hash; POST has no effect",
  "cron/sync/route.ts": "cron bearer",
};

describe("every /api/ebay route is gated", () => {
  const files = routeFiles(API_DIR);

  it("finds the routes", () => {
    expect(files.length).toBeGreaterThanOrEqual(14);
  });

  for (const file of files) {
    const rel = relative(API_DIR, file).replace(/\\/g, "/");
    if (rel in OWN_AUTH && rel !== "cron/sync/route.ts" && rel !== "oauth/start/route.ts") continue;
    it(`${rel} refuses an unauthenticated request with 401 before doing anything`, async () => {
      const mod = (await import(file)) as Record<string, Handler | unknown>;
      const methods = ["GET", "POST"].filter((m) => typeof mod[m] === "function");
      expect(methods.length).toBeGreaterThan(0);
      for (const m of methods) {
        const req = new NextRequest(`http://localhost/api/ebay/${rel.replace("/route.ts", "")}`, { method: m });
        const res = await (mod[m] as Handler)(req, { params: Promise.resolve({ id: "1" }) });
        expect(res.status, `${m} ${rel}`).toBe(401);
        const body = await res.json();
        expect(body.error.code).toBe("unauthorized");
      }
    });
  }

  it("rejects a wrong key and a wrong cron secret", async () => {
    const listings = (await import(join(API_DIR, "listings/route.ts"))) as { GET: Handler };
    const r1 = await listings.GET(new NextRequest("http://localhost/api/ebay/listings", { headers: { "x-api-key": "nope" } }), { params: Promise.resolve({}) });
    expect(r1.status).toBe(401);
    const cron = (await import(join(API_DIR, "cron/sync/route.ts"))) as { GET: Handler };
    const r2 = await cron.GET(new NextRequest("http://localhost/api/ebay/cron/sync", { headers: { authorization: `Bearer ${KEY}` } }), { params: Promise.resolve({}) });
    expect(r2.status).toBe(401); // the api key is not the cron secret
  });

  it("the oauth callback rejects a missing state without touching the database", async () => {
    const cb = (await import(join(API_DIR, "oauth/callback/route.ts"))) as { GET: (r: NextRequest) => Promise<Response> };
    const res = await cb.GET(new NextRequest("http://localhost/api/ebay/oauth/callback?code=abc"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    const declined = await cb.GET(new NextRequest("http://localhost/api/ebay/oauth/callback?declined=1"));
    expect(await declined.text()).toContain("declined");
  });
});

describe("proxy matcher", () => {
  const re = new RegExp(`^${proxyConfig.matcher[0]}$`);
  it("leaves /api/ebay/* to the routes' own auth and still gates the dashboard", () => {
    for (const p of ["/api/ebay/listings", "/api/ebay/oauth/callback", "/api/ebay/cron/sync", "/api/ebay"]) expect(re.test(p), p).toBe(false);
    for (const p of ["/", "/ledger", "/data/ebay", "/api/ebayx", "/api/other"]) expect(re.test(p), p).toBe(true);
  });
});

describe("account deletion", () => {
  it("answers eBay's challenge with SHA-256(code + token + endpoint) hex", () => {
    const cfg = { verificationToken: TOKEN, endpoint: ENDPOINT };
    const expected = createHash("sha256").update(`abc123${TOKEN}${ENDPOINT}`).digest("hex");
    expect(challengeResponse("abc123", cfg)).toBe(expected);
  });

  it("validates its configuration", () => {
    expect(() => getDeletionConfig({})).toThrow(/not configured/);
    expect(() => getDeletionConfig({ EBAY_VERIFICATION_TOKEN: "short", EBAY_ACCOUNT_DELETION_ENDPOINT: ENDPOINT })).toThrow(/32-80/);
  });

  it("GET returns the challenge JSON; POST acknowledges 200; unconfigured is 503", async () => {
    const mod = (await import(join(API_DIR, "account-deletion/route.ts"))) as { GET: Handler; POST: Handler };
    const ctx = { params: Promise.resolve({}) };
    expect((await mod.GET(new NextRequest("http://localhost/x?challenge_code=c"), ctx)).status).toBe(503);
    process.env.EBAY_VERIFICATION_TOKEN = TOKEN;
    process.env.EBAY_ACCOUNT_DELETION_ENDPOINT = ENDPOINT;
    const res = await mod.GET(new NextRequest("http://localhost/x?challenge_code=c"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ challengeResponse: createHash("sha256").update(`c${TOKEN}${ENDPOINT}`).digest("hex") });
    const post = await mod.POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify({ notification: { data: { username: "someone" } } }) }), ctx);
    expect(post.status).toBe(200);
    expect((await mod.GET(new NextRequest("http://localhost/x"), ctx)).status).toBe(400);
  });
});

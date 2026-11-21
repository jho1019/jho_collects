import { describe, expect, it } from "vitest";
import { hasValidApiKey, requireApiKey, requireCronSecret, safeEqual } from "../auth";
import { ApiError } from "../errors";
import { apiRoute } from "../respond";
import type { NextRequest } from "next/server";

const KEY = "k_0123456789abcdef0123456789abcdef";

function h(init: Record<string, string> = {}) {
  return new Headers(init);
}

function caught(fn: () => void): ApiError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("expected an ApiError");
}

describe("safeEqual", () => {
  it("matches equal strings and rejects different ones of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false); // no throw on unequal length
    expect(safeEqual("", "x")).toBe(false);
  });
});

describe("requireApiKey", () => {
  const env = { SHOTIME_API_KEY: KEY };

  it("accepts the right key", () => {
    expect(() => requireApiKey(h({ "x-api-key": KEY }), env)).not.toThrow();
    expect(hasValidApiKey(h({ "x-api-key": KEY }), env)).toBe(true);
  });

  it("rejects a missing key with 401", () => {
    const e = caught(() => requireApiKey(h(), env));
    expect(e.status).toBe(401);
    expect(e.code).toBe("unauthorized");
  });

  it("rejects a wrong key (including a prefix of the right one) with 401", () => {
    expect(caught(() => requireApiKey(h({ "x-api-key": "nope" }), env)).status).toBe(401);
    expect(caught(() => requireApiKey(h({ "x-api-key": KEY.slice(0, -1) }), env)).status).toBe(401);
  });

  it("fails closed with 503 when SHOTIME_API_KEY is unset or blank", () => {
    for (const bad of [{}, { SHOTIME_API_KEY: "" }, { SHOTIME_API_KEY: "   " }]) {
      const e = caught(() => requireApiKey(h({ "x-api-key": "" }), bad));
      expect(e.status).toBe(503);
      expect(e.code).toBe("misconfigured");
      expect(hasValidApiKey(h({ "x-api-key": "" }), bad)).toBe(false);
    }
  });
});

describe("requireCronSecret", () => {
  const env = { CRON_SECRET: "cron-secret-value" };
  it("accepts Vercel's bearer header", () => {
    expect(() => requireCronSecret(h({ authorization: "Bearer cron-secret-value" }), env)).not.toThrow();
  });
  it("rejects wrong / missing / non-bearer", () => {
    expect(caught(() => requireCronSecret(h({ authorization: "Bearer x" }), env)).status).toBe(401);
    expect(caught(() => requireCronSecret(h(), env)).status).toBe(401);
    expect(caught(() => requireCronSecret(h({ authorization: "cron-secret-value" }), env)).status).toBe(401);
  });
  it("fails closed when CRON_SECRET is unset", () => {
    expect(caught(() => requireCronSecret(h({ authorization: "Bearer " }), {})).status).toBe(503);
  });
});

describe("apiRoute", () => {
  it("renders the JSON error shape and never runs the handler without a key", async () => {
    process.env.SHOTIME_API_KEY = KEY;
    let ran = false;
    const route = apiRoute(async () => {
      ran = true;
      return { ok: true };
    });
    const res = await route(new Request("http://x/api/ebay/listings") as NextRequest, {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "missing or invalid x-api-key" } });
    expect(ran).toBe(false);

    const ok = await route(new Request("http://x", { headers: { "x-api-key": KEY } }) as NextRequest, {});
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(ok.headers.get("cache-control")).toBe("no-store");
    delete process.env.SHOTIME_API_KEY;
  });

  it("hides unknown error messages behind a generic 500", async () => {
    const route = apiRoute(async () => {
      throw new Error("token=SECRET leaked");
    }, "none");
    const res = await route(new Request("http://x") as NextRequest, {});
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET");
  });
});

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The callback must never touch Supabase or eBay on a declined/incomplete
// redirect. ebayContext is the only way it reaches either, so it is mocked to
// fail the test if called.
const ebayContext = vi.fn(() => {
  throw new Error("ebayContext must not be called");
});
vi.mock("@/lib/ebay-api/context", () => ({ ebayContext }));

const { GET } = await import("@/app/api/ebay/oauth/callback/route");
const call = (qs: string) => GET(new NextRequest(`https://jho-collects.vercel.app/api/ebay/oauth/callback${qs}`));

beforeEach(() => {
  ebayContext.mockClear();
});

describe("oauth callback: declined flows", () => {
  // eBay's decline redirect goes to the same URL as acceptance and has no `code`.
  it.each([
    ["?error=access_denied", "error=access_denied"],
    ["?error=access_denied&state=abc", "error with state"],
    ["?state=abc", "state only (eBay decline: no code)"],
    ["", "bare URL"],
    ["?declined=1", "legacy declined URL"],
  ])("%s (%s) -> friendly declined page, nothing stored", async (qs) => {
    const res = await call(qs);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("eBay authorization declined");
    expect(html).toContain("nothing was saved");
    expect(html).not.toContain("access_denied"); // eBay's raw values are never echoed
    expect(ebayContext).not.toHaveBeenCalled();
  });

  it("a code without a state is a failure, still without touching the database", async () => {
    const res = await call("?code=abc");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("missing its code or state");
    expect(ebayContext).not.toHaveBeenCalled();
  });

  it("an error param wins even if a code is present", async () => {
    const res = await call("?code=abc&state=def&error=access_denied");
    expect(await res.text()).toContain("declined");
    expect(ebayContext).not.toHaveBeenCalled();
  });
});

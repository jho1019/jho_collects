import { beforeEach, describe, expect, it } from "vitest";
import { USER_SCOPES } from "../config";
import { ApiError } from "../errors";
import { buildConsentUrl, clearAppTokenCache, exchangeCode, getAppToken, hashState } from "../oauth";
import { clearTokenInflight, getUserAccessToken, tokenStatus, type StoredUserToken, type TokenStore } from "../tokens";
import { jsonRes, mockFetch, testConfig } from "./helpers";

const NOW = new Date("2026-11-21T12:00:00Z");

function memStore(initial: StoredUserToken | null) {
  let row = initial ? { ...initial } : null;
  const saves: StoredUserToken[] = [];
  const store: TokenStore = {
    async load() {
      return row ? { ...row } : null;
    },
    async save(t) {
      saves.push(t);
      row = { ...t };
    },
  };
  return { store, saves, get row() { return row; } };
}

function token(over: Partial<StoredUserToken> = {}): StoredUserToken {
  return {
    environment: "production",
    seller: "default",
    accessToken: "old-access",
    accessTokenExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
    refreshToken: "refresh-1",
    refreshTokenExpiresAt: new Date(NOW.getTime() + 400 * 86_400_000),
    scopes: [...USER_SCOPES],
    ...over,
  };
}

beforeEach(() => {
  clearTokenInflight();
  clearAppTokenCache();
});

describe("consent URL", () => {
  it("carries client id, RuName, code, %20-joined scopes and state", () => {
    const url = new URL(buildConsentUrl(testConfig, "st@te", USER_SCOPES));
    expect(url.origin + url.pathname).toBe("https://auth.ebay.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("Test-RuName");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("st@te");
    expect(url.searchParams.get("scope")!.split(" ")).toEqual([...USER_SCOPES]);
    expect(url.search).toContain("%20");
    expect(url.search).not.toContain("+");
  });

  it("hashes state deterministically and never returns the raw value", () => {
    expect(hashState("abc")).toBe(hashState("abc"));
    expect(hashState("abc")).not.toContain("abc");
    expect(hashState("abc")).toHaveLength(64);
  });
});

describe("exchangeCode", () => {
  it("posts the code with Basic auth and computes both expiries", async () => {
    const m = mockFetch().on("POST", "/identity/v1/oauth2/token", {
      access_token: "a", expires_in: 7200, refresh_token: "r", refresh_token_expires_in: 47304000,
    });
    const g = await exchangeCode(testConfig, m.fetch, "v^1.1#code", NOW);
    expect(g.refreshToken).toBe("r");
    expect(g.accessTokenExpiresAt.getTime()).toBe(NOW.getTime() + 7200_000);
    expect(g.refreshTokenExpiresAt!.getTime()).toBe(NOW.getTime() + 47304000_000);
    const req = m.calls[0];
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    const form = new URLSearchParams(req.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("v^1.1#code");
    expect(form.get("redirect_uri")).toBe("Test-RuName");
  });

  it("surfaces an OAuth error without echoing the secret", async () => {
    const m = mockFetch().on("POST", "/oauth2/token", () =>
      jsonRes({ error: "invalid_grant", error_description: "the code has expired" }, 400));
    const err = await exchangeCode(testConfig, m.fetch, "c", NOW).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("ebay_oauth_failed");
    expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain("client-secret");
  });
});

describe("getUserAccessToken", () => {
  it("returns a fresh stored token without calling eBay", async () => {
    const s = memStore(token());
    const m = mockFetch();
    expect(await getUserAccessToken({ store: s.store, config: testConfig, fetch: m.fetch, now: () => NOW })).toBe("old-access");
    expect(m.calls).toHaveLength(0);
  });

  it("refreshes a token inside the 2-minute window and stores it", async () => {
    const s = memStore(token({ accessTokenExpiresAt: new Date(NOW.getTime() + 90_000) }));
    const m = mockFetch().on("POST", "/oauth2/token", { access_token: "new-access", expires_in: 7200 });
    const got = await getUserAccessToken({ store: s.store, config: testConfig, fetch: m.fetch, now: () => NOW });
    expect(got).toBe("new-access");
    const form = new URLSearchParams(m.calls[0].body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("refresh-1");
    expect(form.get("scope")!.split(" ")).toEqual([...USER_SCOPES]);
    expect(s.saves).toHaveLength(1);
    expect(s.row!.accessToken).toBe("new-access");
    expect(s.row!.accessTokenExpiresAt!.getTime()).toBe(NOW.getTime() + 7200_000);
    expect(s.row!.refreshToken).toBe("refresh-1"); // eBay does not rotate it
  });

  it("refreshes an expired token exactly once for concurrent callers (single-flight)", async () => {
    const s = memStore(token({ accessToken: null, accessTokenExpiresAt: null }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = mockFetch().on("POST", "/oauth2/token", async () => {
      await gate;
      return jsonRes({ access_token: "shared", expires_in: 7200 });
    });
    const deps = { store: s.store, config: testConfig, fetch: m.fetch, now: () => NOW };
    const all = Promise.all([1, 2, 3, 4, 5].map(() => getUserAccessToken(deps)));
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await all).toEqual(["shared", "shared", "shared", "shared", "shared"]);
    expect(m.calls.filter((c) => c.url.includes("oauth2/token"))).toHaveLength(1);
    expect(s.saves).toHaveLength(1);
  });

  it("maps invalid_grant to 503 ebay_reauth_required and stores nothing", async () => {
    const s = memStore(token({ accessTokenExpiresAt: new Date(NOW.getTime() - 1) }));
    const m = mockFetch().on("POST", "/oauth2/token", () => jsonRes({ error: "invalid_grant" }, 400));
    const err = await getUserAccessToken({ store: s.store, config: testConfig, fetch: m.fetch, now: () => NOW }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(err.code).toBe("ebay_reauth_required");
    expect(s.saves).toHaveLength(0);
    // the failed flight is cleared, so the next call retries
    m.on("POST", "/oauth2/token", { access_token: "after", expires_in: 7200 });
    expect(await getUserAccessToken({ store: s.store, config: testConfig, fetch: m.fetch, now: () => NOW })).toBe("after");
  });

  it("other refresh failures propagate as ebay errors", async () => {
    const s = memStore(token({ accessTokenExpiresAt: new Date(NOW.getTime() - 1) }));
    const m = mockFetch().on("POST", "/oauth2/token", () => new Response("<html>oops</html>", { status: 500 }));
    const err = await getUserAccessToken({ store: s.store, config: testConfig, fetch: m.fetch, now: () => NOW }).catch((e) => e);
    expect(err.code).toBe("ebay_oauth_failed");
    expect(err.message).not.toContain("<html>");
  });

  it("does not try to refresh with an expired refresh token", async () => {
    const s = memStore(token({ accessTokenExpiresAt: new Date(NOW.getTime() - 1), refreshTokenExpiresAt: new Date(NOW.getTime() - 1) }));
    const m = mockFetch();
    const err = await getUserAccessToken({ store: s.store, config: testConfig, fetch: m.fetch, now: () => NOW }).catch((e) => e);
    expect(err.code).toBe("ebay_reauth_required");
    expect(m.calls).toHaveLength(0);
  });

  it("503 ebay_not_connected when nothing is stored", async () => {
    const err = await getUserAccessToken({ store: memStore(null).store, config: testConfig, fetch: mockFetch().fetch }).catch((e) => e);
    expect(err.code).toBe("ebay_not_connected");
  });
});

describe("tokenStatus", () => {
  it("never includes token values and warns near refresh expiry", () => {
    const st = tokenStatus(token({ refreshTokenExpiresAt: new Date(NOW.getTime() + 10 * 86_400_000) }), NOW);
    expect(JSON.stringify(st)).not.toMatch(/old-access|refresh-1/);
    expect(st.connected && st.refresh_token_days_left).toBe(10);
    expect(st.connected && st.warning).toMatch(/expires in 10 day/);
    expect(tokenStatus(token(), NOW)).toMatchObject({ connected: true, warning: null, access_token_valid: true });
    expect(tokenStatus(null)).toEqual({ connected: false });
  });
});

describe("getAppToken", () => {
  it("caches the client-credentials token per scope set", async () => {
    const m = mockFetch().on("POST", "/oauth2/token", { access_token: "app", expires_in: 7200 });
    const t = 1_000_000;
    expect(await getAppToken(testConfig, m.fetch, ["s1"], () => t)).toBe("app");
    expect(await getAppToken(testConfig, m.fetch, ["s1"], () => t + 1000)).toBe("app");
    expect(m.calls).toHaveLength(1);
    expect(new URLSearchParams(m.calls[0].body).get("grant_type")).toBe("client_credentials");
    // near expiry -> new token
    await getAppToken(testConfig, m.fetch, ["s1"], () => t + 7200_000 - 60_000);
    expect(m.calls).toHaveLength(2);
  });
});

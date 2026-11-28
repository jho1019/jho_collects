import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayEnvironment, Env } from "./config";
import { ApiError, ConfigError } from "./errors";
import type { ListingLink, ListingLinkStore } from "./cdp/import";
import type { ConfigStore } from "./policies";
import type { AuditStore, ListingStateStore } from "./price";
import type { StoredUserToken, TokenStore } from "./tokens";

// Supabase-backed implementations of the storage interfaces. Every table here
// is RLS-locked with no policies (schema/024), so these must be given the
// service-role client from lib/supabase/admin.ts.
//
// Supabase errors are logged by message server-side and surfaced as a
// generic 500-class ApiError — never echoed to the caller.

function dbError(op: string, err: { message?: string } | null): ApiError {
  console.error(`[ebay-api] supabase ${op} failed:`, err?.message);
  return new ApiError(500, "database_error", `database error during ${op}`);
}

const dateOrNull = (s: string | null | undefined) => (s ? new Date(s) : null);

/** numeric comes back from PostgREST as a JSON number; render cents. */
export const money2 = (n: number | string | null | undefined) =>
  n === null || n === undefined ? null : Number(n).toFixed(2);

// ------------------------------------------------------------------ tokens

export function supabaseTokenStore(db: SupabaseClient, seller = "default"): TokenStore {
  return {
    async load(environment) {
      const { data, error } = await db.from("ebay_tokens")
        .select("environment, seller, access_token, access_token_expires_at, refresh_token, refresh_token_expires_at, scopes")
        .eq("environment", environment).eq("seller", seller).maybeSingle();
      if (error) throw dbError("load token", error);
      if (!data) return null;
      return {
        environment: data.environment,
        seller: data.seller,
        accessToken: data.access_token,
        accessTokenExpiresAt: dateOrNull(data.access_token_expires_at),
        refreshToken: data.refresh_token,
        refreshTokenExpiresAt: dateOrNull(data.refresh_token_expires_at),
        scopes: data.scopes ?? [],
      } satisfies StoredUserToken;
    },
    async save(t) {
      const { error } = await db.from("ebay_tokens").upsert({
        environment: t.environment,
        seller: t.seller,
        access_token: t.accessToken,
        access_token_expires_at: t.accessTokenExpiresAt?.toISOString() ?? null,
        refresh_token: t.refreshToken,
        refresh_token_expires_at: t.refreshTokenExpiresAt?.toISOString() ?? null,
        scopes: t.scopes,
        updated_at: new Date().toISOString(),
      }, { onConflict: "environment,seller" });
      if (error) throw dbError("save token", error);
    },
  };
}

// ------------------------------------------------------------------ oauth state

export async function saveOAuthState(db: SupabaseClient, row: {
  stateHash: string; environment: EbayEnvironment; scopes: string[]; expiresAt: Date;
}): Promise<void> {
  // Housekeeping first: states older than a day are dead weight. Bounded WHERE.
  await db.from("ebay_oauth_states").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString());
  const { error } = await db.from("ebay_oauth_states").insert({
    state_hash: row.stateHash, environment: row.environment, scopes: row.scopes, expires_at: row.expiresAt.toISOString(),
  });
  if (error) throw dbError("save oauth state", error);
}

/** Single use: a conditional UPDATE claims the state, so a replay finds nothing. */
export async function consumeOAuthState(db: SupabaseClient, stateHash: string, environment: EbayEnvironment): Promise<string[] | null> {
  const now = new Date().toISOString();
  const { data, error } = await db.from("ebay_oauth_states")
    .update({ used_at: now })
    .eq("state_hash", stateHash).eq("environment", environment).is("used_at", null).gt("expires_at", now)
    .select("scopes");
  if (error) throw dbError("consume oauth state", error);
  return data?.[0]?.scopes ?? null;
}

// ------------------------------------------------------------------ config

export function supabaseConfigStore(db: SupabaseClient): ConfigStore {
  return {
    async getAll(environment) {
      const { data, error } = await db.from("ebay_config").select("key, value").eq("environment", environment);
      if (error) throw dbError("read config", error);
      return Object.fromEntries((data ?? []).map((r) => [r.key, r.value]));
    },
    async set(environment, values) {
      const rows = Object.entries(values).map(([key, value]) => ({ environment, key, value, updated_at: new Date().toISOString() }));
      if (!rows.length) return;
      const { error } = await db.from("ebay_config").upsert(rows, { onConflict: "environment,key" });
      if (error) throw dbError("write config", error);
    },
  };
}

// ------------------------------------------------------------------ audit

export function supabaseAuditStore(db: SupabaseClient): AuditStore {
  return {
    async logPriceChange(row) {
      const { error } = await db.from("price_changes").insert(row);
      if (error) throw dbError("log price change", error);
    },
    async logListingEvent(row) {
      const { error } = await db.from("listing_events").insert(row);
      if (error) throw dbError("log listing event", error);
    },
  };
}

export async function recentPriceChanges(db: SupabaseClient, environment: EbayEnvironment, limit: number, offerId?: string) {
  let q = db.from("price_changes")
    .select("id, offer_id, sku, listing_id, old_price, new_price, currency, reason, status, http_status, error, actor, created_at")
    .eq("environment", environment).order("created_at", { ascending: false }).limit(limit);
  if (offerId) q = q.eq("offer_id", offerId);
  const { data, error } = await q;
  if (error) throw dbError("read price changes", error);
  return (data ?? []).map((r) => ({ ...r, old_price: money2(r.old_price), new_price: money2(r.new_price) }));
}

// ------------------------------------------------------------------ owner
// The ledger is RLS-scoped per user; the service role has no auth.uid(), so
// card lookups need the owner's id explicitly. Same env var name as the
// Python importers (.env.local OWNER_USER_ID). Falls back to the single
// auth user when exactly one exists.

let ownerCache: string | null = null;

export async function resolveOwnerUserId(db: SupabaseClient, env: Env = process.env): Promise<string> {
  const fromEnv = env.OWNER_USER_ID?.trim();
  if (fromEnv) {
    if (!/^[0-9a-f-]{36}$/i.test(fromEnv)) throw new ConfigError("OWNER_USER_ID is not a UUID");
    return fromEnv;
  }
  if (ownerCache) return ownerCache;
  const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 2 });
  if (error) throw dbError("list auth users", error);
  if (data.users.length !== 1) {
    throw new ConfigError(`set OWNER_USER_ID: auth has ${data.users.length === 2 ? "several" : "no"} users`);
  }
  ownerCache = data.users[0].id;
  return ownerCache;
}

// ------------------------------------------------------------------ ebay_listings

export function supabaseListingStore(db: SupabaseClient, env: Env = process.env): ListingLinkStore & ListingStateStore {
  return {
    async upsert(environment, links: ListingLink[]) {
      const owner = await resolveOwnerUserId(db, env).catch(() => null);
      const cards = new Map<string, number>();
      if (owner) {
        // Personal-collection cards are never linked to an eBay listing
        // (schema/027): a pc card is excluded from every eBay tool.
        const { data, error } = await db.from("cards").select("id, sku")
          .eq("user_id", owner).neq("category", "pc").in("sku", links.map((l) => l.sku));
        if (error) throw dbError("look up cards by sku", error);
        for (const c of data ?? []) cards.set(c.sku, c.id);
      }
      const rows = links.map((l) => ({
        environment, sku: l.sku, offer_id: l.offerId, listing_id: l.listingId, title: l.title,
        price: l.price, status: l.status, card_id: cards.get(l.sku) ?? null, updated_at: new Date().toISOString(),
      }));
      const { error } = await db.from("ebay_listings").upsert(rows, { onConflict: "environment,sku" });
      if (error) throw dbError("upsert ebay_listings", error);
      return new Map(links.map((l) => [l.sku, cards.get(l.sku) ?? null]));
    },
    async setPrice(environment, offerId, price) {
      const { error } = await db.from("ebay_listings").update({ price, updated_at: new Date().toISOString() })
        .eq("environment", environment).eq("offer_id", offerId);
      if (error) throw dbError("update listing price", error);
    },
    // Is this offer a personal-collection card? By the card's eBay sku (owner
    // scoped), then by the ebay_listings link. Errors fail closed (throw), so
    // a lookup failure blocks the reprice rather than letting a pc card through.
    async isPersonalCollection(environment, ref) {
      const owner = await resolveOwnerUserId(db, env).catch(() => null);
      if (owner && ref.sku) {
        const { data, error } = await db.from("cards").select("id")
          .eq("user_id", owner).eq("sku", ref.sku).eq("category", "pc").limit(1);
        if (error) throw dbError("check pc card by sku", error);
        if (data?.length) return true;
      }
      if (ref.offerId) {
        const { data: link, error } = await db.from("ebay_listings").select("card_id")
          .eq("environment", environment).eq("offer_id", ref.offerId).maybeSingle();
        if (error) throw dbError("check pc card by listing", error);
        if (link?.card_id) {
          const { data, error: e2 } = await db.from("cards").select("id")
            .eq("id", link.card_id).eq("category", "pc").limit(1);
          if (e2) throw dbError("check pc card by listing", e2);
          if (data?.length) return true;
        }
      }
      return false;
    },
    async markEnded(environment, offerId) {
      const { error } = await db.from("ebay_listings").update({ status: "ended", updated_at: new Date().toISOString() })
        .eq("environment", environment).eq("offer_id", offerId);
      if (error) throw dbError("mark listing ended", error);
    },
  };
}

import { createHash } from "node:crypto";
import type { Env } from "./config";
import { ConfigError } from "./errors";

// eBay Marketplace Account Deletion notifications — required (or an
// exemption) before a PRODUCTION keyset is activated.
//
//   GET  ?challenge_code=X  -> 200 {"challengeResponse": hex(SHA-256(X + verificationToken + endpoint))}
//   POST notification       -> 200 acknowledgement
//
// `endpoint` must be byte-for-byte the URL registered in the developer
// portal, which is why it is an env var rather than derived from the request
// (a proxy can change scheme/host/query as seen by the function).

export interface DeletionConfig {
  verificationToken: string;
  endpoint: string;
}

export function getDeletionConfig(env: Env = process.env): DeletionConfig {
  const verificationToken = env.EBAY_VERIFICATION_TOKEN?.trim() ?? "";
  const endpoint = env.EBAY_ACCOUNT_DELETION_ENDPOINT?.trim() ?? "";
  const missing = [!verificationToken && "EBAY_VERIFICATION_TOKEN", !endpoint && "EBAY_ACCOUNT_DELETION_ENDPOINT"].filter(Boolean);
  if (missing.length) throw new ConfigError("account deletion endpoint is not configured", { missing_env: missing });
  // eBay: 32-80 characters, alphanumeric, underscore and hyphen only.
  if (!/^[A-Za-z0-9_-]{32,80}$/.test(verificationToken)) {
    throw new ConfigError("EBAY_VERIFICATION_TOKEN must be 32-80 characters of A-Z a-z 0-9 _ -");
  }
  return { verificationToken, endpoint };
}

export function challengeResponse(challengeCode: string, cfg: DeletionConfig): string {
  return createHash("sha256")
    .update(challengeCode, "utf8")
    .update(cfg.verificationToken, "utf8")
    .update(cfg.endpoint, "utf8")
    .digest("hex");
}

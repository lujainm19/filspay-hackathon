import type { Pool } from "pg";
import type { Config } from "../config.js";
import { randomToken } from "../lib/crypto.js";
import { BadRequestError } from "../lib/errors.js";
import { decodeEncryptionKey, encryptSecret } from "./secretCrypto.js";
import { isLocalHostname, isPrivateAddress } from "./ssrf.js";

/**
 * Validates a webhook endpoint URL: must parse as an absolute URL with
 * scheme http/https; https is required once config.nodeEnv === 'production'
 * (http is permitted otherwise so a local http.createServer test receiver
 * and a merchant's own localhost dev setup both work).
 */
// S18 fix: what was wrong — "https only in production" was the only SSRF
// protection, so https://10.0.0.5/ or http://settlement:8091/internal/... (http
// was allowed because NODE_ENV was unset) were accepted. Why it matters — the
// dispatcher POSTs to this URL from inside our network. What it broke — a
// merchant could make our server call internal services or the cloud metadata
// endpoint. In production we now also refuse local hostnames and private /
// loopback / link-local IP literals; the transport re-checks the resolved IP at
// send time (see transport.ts), which also catches DNS names that resolve
// inside. Dev and test still allow localhost for the local test receiver.
export function validateWebhookUrl(rawUrl: string, config: Pick<Config, "nodeEnv">): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new BadRequestError("invalid_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError("invalid_url");
  }
  if (config.nodeEnv === "production") {
    if (parsed.protocol !== "https:") {
      throw new BadRequestError("invalid_url");
    }
    if (isLocalHostname(parsed.hostname) || isPrivateAddress(parsed.hostname)) {
      throw new BadRequestError("invalid_url", "webhook URLs must point at a public internet address");
    }
  }
  return parsed;
}

export interface CreateWebhookEndpointInput {
  merchantId: string;
  url: string;
  createdByType: "merchant_session" | "merchant_api_key";
  createdById: string;
}

/** The signing secret is returned here in plaintext once and never again. */
export interface CreatedWebhookEndpoint {
  id: string;
  url: string;
  secretPrefix: string;
  status: string;
  createdAt: Date;
  /** appears here and nowhere else, ever — the classic show-once pattern
   *  api_keys already uses. */
  secret: string;
}

/**
 * `POST /v1/merchants/:merchantId/webhook-endpoints` business logic.
 */
export async function createWebhookEndpoint(
  pool: Pool,
  config: Pick<Config, "nodeEnv" | "webhookSecretEncryptionKey">,
  input: CreateWebhookEndpointInput,
): Promise<CreatedWebhookEndpoint> {
  validateWebhookUrl(input.url, config);

  const rawSecret = `whsec_${randomToken(24)}`;
  const secretPrefix = rawSecret.slice(0, 14);
  const secretCiphertext = encryptSecret(rawSecret, decodeEncryptionKey(config.webhookSecretEncryptionKey));

  const result = await pool.query<{
    id: string;
    url: string;
    secret_prefix: string;
    status: string;
    created_at: Date;
  }>(
    `INSERT INTO webhook_endpoints (merchant_id, url, secret_ciphertext, secret_prefix, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, url, secret_prefix, status, created_at`,
    [input.merchantId, input.url, secretCiphertext, secretPrefix, input.createdByType, input.createdById],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error("createWebhookEndpoint: insert into webhook_endpoints returned no row");
  }

  return {
    id: row.id,
    url: row.url,
    secretPrefix: row.secret_prefix,
    status: row.status,
    createdAt: row.created_at,
    secret: rawSecret,
  };
}

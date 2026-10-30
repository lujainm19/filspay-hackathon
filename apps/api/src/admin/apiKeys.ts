import type { Pool } from "pg";
import type { Config } from "../config.js";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { issueApiKeyInTx, type IssuedApiKey } from "../apiKeys/issue.js";
import { withTransaction } from "../db/withTransaction.js";
import { ConflictError, NotFoundError } from "../lib/errors.js";

export interface RotatedApiKey extends IssuedApiKey {
  previousKeyId: string;
}

/** Rotates a merchant's API key, atomically with its audit row. */
export async function rotateApiKeyAsAdmin(
  pool: Pool,
  config: Pick<Config, "nodeEnv">,
  input: { merchantId: string; apiKeyId: string; adminUserId: string; label?: string },
): Promise<RotatedApiKey> {
  return withTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string; label: string | null; revoked_at: Date | null }>(
      `SELECT id, label, revoked_at FROM api_keys WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
      [input.apiKeyId, input.merchantId],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new NotFoundError("api_key_not_found");
    }
    if (row.revoked_at) {
      throw new ConflictError("api_key_already_revoked");
    }

    // A3 fix: what was wrong — rotation issued a new key but never retired the
    // old one, so it kept working forever. Why it matters — the usual reason to
    // rotate is that the old key leaked. What it broke — a leaked key still
    // worked after support "rotated" it.
    // Team decision (docs/PARTNER_FIXES.md): give the merchant a 24-hour
    // overlap to deploy the new key, then the old one stops. We use the
    // revoke_after column from 0056 and verifyApiKey checks it, so there's no
    // sweep job to forget to run. (For a key that's known to have leaked, the
    // right move is an immediate revoke, not a rotation.)
    await client.query(
      `UPDATE api_keys SET revoke_after = now() + interval '24 hours'
        WHERE id = $1 AND (revoke_after IS NULL OR revoke_after > now() + interval '24 hours')`,
      [input.apiKeyId],
    );

    const issued = await issueApiKeyInTx(client, config, {
      merchantId: input.merchantId,
      createdByAdminUserId: input.adminUserId,
      label: input.label ?? row.label ?? undefined,
      rotatedFromKeyId: input.apiKeyId,
    });

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "api_key_rotate",
      targetType: "api_key",
      targetId: input.apiKeyId,
      metadata: { merchantId: input.merchantId, newKeyId: issued.id },
    });

    return { ...issued, previousKeyId: input.apiKeyId };
  });
}

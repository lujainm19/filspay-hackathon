import type { Pool } from "pg";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";

export interface BulkApproveMerchantsKycInput {
  merchantIds: string[];
  adminUserId: string;
  notes?: string;
}

/**
 * @property approvedMerchantIds Only merchants that moved from under_review to approved.
 * Already-approved or rejected ids are skipped and not listed.
 */
export interface BulkApproveMerchantsKycResult {
  approvedCount: number;
  approvedMerchantIds: string[];
}

/** Approves the given merchants and audits it. */
export async function bulkApproveMerchantsKyc(
  pool: Pool,
  input: BulkApproveMerchantsKycInput,
): Promise<BulkApproveMerchantsKycResult> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{ id: string }>(
      // A5 fix: what was wrong — no status filter. Why it matters — ADMIN.md
      // promises "only merchants currently under_review are affected". What
      // it broke — ticking a rejected (or never-submitted) merchant approved it
      // for live payments with no review. The returned ids (and the audit row)
      // show exactly which ones were approved.
      `UPDATE merchants
          SET onboarding_status = 'approved', kyc_passed = true
        WHERE id = ANY($1::uuid[]) AND onboarding_status = 'under_review'
      RETURNING id`,
      [input.merchantIds],
    );
    const approvedMerchantIds = result.rows.map((row) => row.id);

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "kyc_bulk_approve",
      targetType: "platform",
      targetId: null,
      metadata: {
        requestedMerchantIds: input.merchantIds,
        approvedMerchantIds,
        notes: input.notes ?? null,
      },
    });

    return { approvedCount: approvedMerchantIds.length, approvedMerchantIds };
  });
}

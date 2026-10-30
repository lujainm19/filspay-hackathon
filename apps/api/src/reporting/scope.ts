import type { Pool } from "pg";

export async function resolveReportMerchantId(
  pool: Pool,
  callerMerchantId: string,
  requestedMerchantId?: string,
): Promise<string> {
  if (!requestedMerchantId || requestedMerchantId === callerMerchantId) {
    return callerMerchantId;
  }

  // S9 fix: what was wrong — this only checked that the requested merchant is
  // a split child of *someone*. Why — the parent column was never compared to
  // the caller. What it broke — any merchant could read any marketplace
  // child's transaction report just by passing that child's id. Now the child
  // must belong to the caller.
  const result = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok FROM merchant_split_children
      WHERE child_merchant_id = $1 AND parent_merchant_id = $2`,
    [requestedMerchantId, callerMerchantId],
  );
  if (result.rows.length === 0) {
    return callerMerchantId;
  }
  return requestedMerchantId;
}

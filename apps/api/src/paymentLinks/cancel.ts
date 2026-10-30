import type { Pool } from "pg";

export type CancelPaymentLinkResult =
  | { outcome: "canceled" }
  | { outcome: "not_found" }
  | { outcome: "not_cancelable"; status: string };

/**
 * Cancels an active payment link by id.
 *
 * S7 fix: what was wrong — the UPDATE matched on the link id alone. Why — the
 * route's assertOwnMerchant only checks that the merchant in the URL is you; it
 * never checked the link belongs to that merchant. What it broke — merchant A
 * could cancel merchant B's links by putting B's link id in A's own URL. The
 * merchant id is now part of every query here.
 */
export async function cancelPaymentLink(
  pool: Pool,
  input: { id: string; merchantId: string },
): Promise<CancelPaymentLinkResult> {
  const updateResult = await pool.query<{ id: string }>(
    `UPDATE payment_links
        SET status = 'canceled', canceled_at = now()
      WHERE id = $1 AND merchant_id = $2 AND status = 'active'
      RETURNING id`,
    [input.id, input.merchantId],
  );
  if (updateResult.rows[0]) {
    return { outcome: "canceled" };
  }

  // Same merchant filter, so another merchant's link reads as "not found".
  const lookupResult = await pool.query<{ status: string }>(
    `SELECT status FROM payment_links WHERE id = $1 AND merchant_id = $2`,
    [input.id, input.merchantId],
  );
  const row = lookupResult.rows[0];
  if (!row) {
    return { outcome: "not_found" };
  }
  return { outcome: "not_cancelable", status: row.status };
}

import type { Pool } from "pg";

/** Operational record of a payout-rail instruction for a settlement batch. */
export async function recordPayoutDisbursementEffect(
  pool: Pool,
  settlementBatchId: string,
  amountFils: number,
): Promise<void> {
  if (amountFils <= 0) {
    // Void batches (zero or negative net) carry no payout instruction.
    return;
  }

  // C4: one disbursement per batch (0073's unique index), however many webhook
  // endpoints the merchant has. This runs once per delivery row, i.e. once per
  // endpoint; without ON CONFLICT the second endpoint's insert threw, so that
  // delivery was retried forever and never sent.
  await pool.query(
    `INSERT INTO settlement_payout_disbursements (settlement_batch_id, amount_fils, disbursement_reference)
     VALUES ($1, $2, 'disb_' || gen_random_uuid())
     ON CONFLICT (settlement_batch_id) DO NOTHING`,
    [settlementBatchId, amountFils],
  );
}

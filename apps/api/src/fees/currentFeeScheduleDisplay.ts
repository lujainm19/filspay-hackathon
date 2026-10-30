import type { Pool } from "pg";

/**
 * effectiveFrom: when the rate starts applying. createdAt: when it was
 * keyed in. The display returns the latest row whose effectiveFrom is not
 * in the future.
 */
export interface CurrentFeeScheduleDisplay {
  mdrBps: number;
  effectiveFrom: Date;
  createdAt: Date;
}

/**
 * Fetches the merchant's current negotiated fee schedule for display on the
 * admin merchant-detail page. We only need the newest schedule for display,
 * not point-in-time resolution — an admin looking at this page wants "what
 * did we most recently agree to for this merchant," not "what rate applied
 * to some specific past transaction" (that per-event resolution already
 * exists at capture/settlement time). Ordering by created_at is the
 * simplest way to answer "most recently agreed," since that's literally
 * when the row was entered.
 */
// M10 fix: what was wrong — this picked the most recently *entered* row
// (ORDER BY created_at). Why it broke — a backdated correction (245 bps for
// March, keyed in on 15 Aug) became "current" even though the August
// renegotiation (225 bps) is what capture actually charges. What it broke —
// the dashboard showed 245 bps while payments went through at 225 (Fatima's
// note). Now it shows the rate in effect today, using the same rule as
// feeSchedule.ts (latest effective_from that has arrived; ties → latest entry).
export async function getCurrentFeeScheduleForDisplay(
  pool: Pool,
  merchantId: string,
): Promise<CurrentFeeScheduleDisplay | null> {
  const result = await pool.query<{ mdr_bps: number; effective_from: Date; created_at: Date }>(
    `SELECT mdr_bps, effective_from, created_at
       FROM fee_schedules
      WHERE merchant_id = $1 AND effective_from <= now()
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [merchantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { mdrBps: row.mdr_bps, effectiveFrom: row.effective_from, createdAt: row.created_at };
}

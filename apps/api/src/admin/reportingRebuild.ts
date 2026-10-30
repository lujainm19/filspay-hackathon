import type { PoolClient } from "pg";

/** Counts of outbox_events replayed into each rollup table. */
export interface RebuildAnalyticsSummary {
  volumeRows: number;
  trendRows: number;
}

/** Truncates and repopulates the two rollup tables
 *  (merchant_daily_volume, merchant_payout_trends) from source. */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  // A6 fix: what was wrong — this rebuilt the rollups from every event but
  // left the reporting worker's cursor where it was. Why it broke — the
  // worker then re-applied the events after its cursor, which the rebuild had
  // already counted. What it broke — "Rebuild analytics" (sold as "quick, safe,
  // and repeatable") double-counted recent activity. Now the rebuild reads one
  // consistent snapshot, holds the cursor row so the worker can't run in the
  // middle, and moves the cursor to the last outbox event that snapshot saw.
  // (Must be the first statement of the transaction — the route calls this first.)
  await client.query(`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ('reporting', 0) ON CONFLICT (consumer_name) DO NOTHING`,
  );
  await client.query(`SELECT 1 FROM reporting_outbox_cursor WHERE consumer_name = 'reporting' FOR UPDATE`);

  // YA: ACCESS EXCLUSIVE lock is fine while analytics is internal only (Jan 2026)
  await client.query(`TRUNCATE merchant_daily_volume`);
  await client.query(`TRUNCATE merchant_payout_trends`);

  const trendResult = await client.query(
    `INSERT INTO merchant_payout_trends
        (merchant_id, settlement_batch_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, last_updated_at)
     SELECT merchant_id, id, batch_date, status, gross_fils, fee_fils, net_payout_fils, paid_at, now()
       FROM settlement_batches`,
  );

  const volumeResult = await client.query(
    `INSERT INTO merchant_daily_volume
        (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count, last_updated_at)
     SELECT t.merchant_id,
            (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date,
            COUNT(*) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')),
            COALESCE(SUM(te.amount_fils) FILTER (WHERE te.event_type IN ('captured', 'partially_captured')), 0),
            COUNT(*) FILTER (WHERE te.event_type = 'voided'),
            now()
       FROM transaction_events te
       JOIN transactions t ON t.id = te.transaction_id
      WHERE te.event_type IN ('captured', 'partially_captured', 'voided')
      GROUP BY t.merchant_id, (te.occurred_at AT TIME ZONE 'Asia/Bahrain')::date`,
  );

  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_id = (SELECT COALESCE(MAX(id), 0) FROM outbox_events), updated_at = now()
      WHERE consumer_name = 'reporting'`,
  );

  return { volumeRows: volumeResult.rowCount ?? 0, trendRows: trendResult.rowCount ?? 0 };
}

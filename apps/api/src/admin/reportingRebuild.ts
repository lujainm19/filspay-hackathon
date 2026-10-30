import type { PoolClient } from "pg";

/** Result of POST /v1/admin/reporting/rebuild. */
export interface RebuildAnalyticsSummary {
  /** Rows in the rollup tables right after the reset (always 0). */
  volumeRows: number;
  trendRows: number;
  /** Outbox events the reporting worker will replay to rebuild them. */
  eventsToReplay: number;
  replayQueued: true;
}

/**
 * A6. This used to TRUNCATE the rollups and refill them straight from
 * transaction_events / settlement_batches, while leaving the reporting
 * worker's cursor where it was. The worker then applied every event after
 * that cursor on top of the refilled numbers (double counting), and the
 * source query was a second implementation that already disagreed with the
 * worker (no refunds, different day boundary) — the "M?" warning in
 * apps/reporting/src/cli/rebuild.ts.
 *
 * Now it does exactly what `reporting rebuild` does: in one transaction it
 * locks the cursor row (waiting for an in-flight consumer pass to finish),
 * truncates both rollups and resets the cursor, then NOTIFYs the worker,
 * which replays the whole outbox through the same applyEvent code it runs
 * every day. One code path, so the two can never drift.
 */
export async function refreshAnalyticsRollups(client: PoolClient): Promise<RebuildAnalyticsSummary> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id) VALUES ('reporting', 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
  );
  await client.query(`SELECT 1 FROM reporting_outbox_cursor WHERE consumer_name = 'reporting' FOR UPDATE`);
  await client.query(`TRUNCATE merchant_daily_volume, merchant_payout_trends`);
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_id = 0, last_processed_xid = NULL, updated_at = now()
      WHERE consumer_name = 'reporting'`,
  );
  const pending = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox_events
      WHERE event_type IN ('transaction.captured', 'transaction.voided', 'settlement.batch_closed', 'refund.succeeded')`,
  );
  await client.query(`NOTIFY outbox_events_channel`);
  return { volumeRows: 0, trendRows: 0, eventsToReplay: Number(pending.rows[0]?.n ?? 0), replayQueued: true };
}

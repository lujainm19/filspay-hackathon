import type { Pool } from "pg";
import type { EventType } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { ReportingConfig } from "../config.js";
import { advanceCursor, readCursor } from "./cursor.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

export const REPORTING_EVENT_TYPES: readonly EventType[] = [
  "transaction.captured",
  "transaction.voided",
  "settlement.batch_closed",
  "refund.succeeded",
];

export const CONSUMER_NAME = "reporting";

class EventApplyError extends Error {
  constructor(
    readonly outboxEventId: string,
    readonly cause: unknown,
  ) {
    super(`applyEvent failed for outbox event ${outboxEventId}: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

interface OrderedOutboxEventRow extends OutboxEventRow {
  created_xid: string;
}

/**
 * One consumer pass. Atomic: if any event fails, nothing from the pass
 * persists (rollups and watermark roll back together).
 *
 * Two fixes vs. the original:
 *
 * 1. Ordering. Outbox ids come from a sequence at INSERT time, but
 *    transactions commit in any order. Reading `WHERE id > watermark` meant a
 *    slow transaction's row (lower id, later commit) could land behind the
 *    watermark and be skipped forever. The pass now only reads rows written
 *    by transactions older than every in-flight one
 *    (`created_xid < pg_snapshot_xmin`), in (xid, id) order, so nothing can
 *    later appear behind the cursor.
 *
 * 2. Poison events. One malformed event made every pass throw, forever: the
 *    dashboards silently froze ("readModelAsOf is stuck"). A failing event is
 *    still fatal *for that pass* (atomicity), but it is then recorded in
 *    reporting_dead_letters and skipped by later passes, so the worker
 *    recovers and the event is kept for someone to inspect.
 */
export async function runConsumerPass(
  pool: Pool,
  config: Pick<ReportingConfig, "consumerBatchLimit">,
): Promise<{ processedCount: number }> {
  try {
    return await withTransaction(pool, async (client) => {
      const cursor = await readCursor(client, CONSUMER_NAME);

      const eventsResult = await client.query<OrderedOutboxEventRow>(
        `SELECT oe.id, oe.event_type, oe.aggregate_id, oe.payload, oe.created_at, oe.created_xid::text AS created_xid
           FROM outbox_events oe
          WHERE oe.event_type = ANY($2::text[])
            AND oe.created_xid < pg_snapshot_xmin(pg_current_snapshot())
            AND (
                 ($4::text IS NULL AND oe.id > $1::bigint)
              OR ($4::text IS NOT NULL AND (oe.created_xid, oe.id) > ($4::text::xid8, $1::bigint))
                )
            AND NOT EXISTS (
              SELECT 1 FROM reporting_dead_letters dl
               WHERE dl.outbox_event_id = oe.id AND dl.consumer_name = $5
            )
          ORDER BY oe.created_xid ASC, oe.id ASC
          LIMIT $3`,
        [
          cursor.lastProcessedId.toString(),
          REPORTING_EVENT_TYPES,
          config.consumerBatchLimit,
          cursor.lastProcessedXid,
          CONSUMER_NAME,
        ],
      );

      for (const row of eventsResult.rows) {
        try {
          await applyEvent(client, row);
        } catch (err) {
          throw new EventApplyError(String(row.id), err);
        }
      }

      // refund_merchant_summary (0072) says it is "refreshed by the reporting
      // worker after each settlement run" — nothing ever refreshed it, so the
      // admin refund report was frozen at migration time. Refresh it once per
      // pass that saw a settlement run (batch_closed) or a refund.
      if (eventsResult.rows.some((r) => r.event_type === "settlement.batch_closed" || r.event_type === "refund.succeeded")) {
        await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY refund_merchant_summary`);
      }

      const last = eventsResult.rows[eventsResult.rows.length - 1];
      if (last) {
        // The cursor is the (xid, id) of the last row in commit-safe order.
        await advanceCursor(client, CONSUMER_NAME, BigInt(last.id), last.created_xid);
      }

      return { processedCount: eventsResult.rows.length };
    });
  } catch (err) {
    if (err instanceof EventApplyError) {
      await pool
        .query(
          `INSERT INTO reporting_dead_letters (outbox_event_id, consumer_name, error)
           VALUES ($1, $2, $3) ON CONFLICT (outbox_event_id) DO NOTHING`,
          [err.outboxEventId, CONSUMER_NAME, err.message.slice(0, 2000)],
        )
        .catch(() => {});
    }
    throw err;
  }
}

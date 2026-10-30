import type { QueryableClient } from "@filspay/events";

export interface ConsumerCursor {
  /** id of the last outbox row processed, in (xid, id) order. */
  lastProcessedId: bigint;
  /** xid8 (as text) of the last processed event's transaction; null until
   *  the first pass under the commit-order scheme. */
  lastProcessedXid: string | null;
}

interface CursorRow {
  last_processed_id: string | number;
  last_processed_xid: string | null;
}

/**
 * Reads the cursor *with a row lock*, so two consumers (the worker and a
 * `catch-up` run — RUNBOOK says this is "safe", it wasn't) can never process
 * the same range concurrently and double-apply it.
 */
export async function readCursor(client: QueryableClient, consumerName: string): Promise<ConsumerCursor> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id)
     VALUES ($1, 0)
     ON CONFLICT (consumer_name) DO NOTHING`,
    [consumerName],
  );

  const result = (await client.query(
    `SELECT last_processed_id, last_processed_xid::text AS last_processed_xid
       FROM reporting_outbox_cursor WHERE consumer_name = $1 FOR UPDATE`,
    [consumerName],
  )) as { rows: CursorRow[] };

  const row = result.rows[0];
  const lastProcessedId = row ? BigInt(row.last_processed_id) : 0n;
  return {
    lastProcessedId,
    lastProcessedXid: row?.last_processed_xid ?? null,
  };
}

export async function advanceCursor(
  client: QueryableClient,
  consumerName: string,
  newLastProcessedId: bigint,
  lastProcessedXid?: string,
): Promise<void> {
  await client.query(
    `UPDATE reporting_outbox_cursor
        SET last_processed_id = $2,
            last_processed_xid = COALESCE($3::text::xid8, last_processed_xid),
            updated_at = now()
      WHERE consumer_name = $1`,
    [consumerName, newLastProcessedId.toString(), lastProcessedXid ?? null],
  );
}

// MK: rebuild only. never call from the worker.
export async function resetCursor(client: QueryableClient, consumerName: string): Promise<void> {
  await client.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id, updated_at)
     VALUES ($1, 0, now())
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 0, last_processed_xid = NULL, updated_at = now()`,
    [consumerName],
  );
}

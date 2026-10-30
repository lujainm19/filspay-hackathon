/**
 * New test for A6 (team decision B, Ghadah's version): "Rebuild analytics"
 * empties both rollups AND resets the reporting worker's cursor in the same
 * transaction, so the worker replays every event exactly once through its own
 * applyEvent code. The old button refilled the rollups from source but left
 * the cursor where it was, so the worker then added recent events on top
 * (double counting). Needs DATABASE_URL.
 *
 * That the replay itself rebuilds identical numbers is covered by the
 * reporting package's own runRebuild test.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { refreshAnalyticsRollups } from "./reportingRebuild.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("reportingRebuild.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(async () => {
  await pool.end();
});

test("A6: rebuild empties the rollups and rewinds the worker cursor together, so nothing is counted twice", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `Rebuild ${randomUUID()}`,
  ]);
  // A rollup row the worker already counted, and a cursor that has moved on.
  await pool.query(
    `INSERT INTO merchant_daily_volume (merchant_id, volume_date, captured_count, captured_gross_fils, voided_count, last_updated_at)
     VALUES ($1, '2026-10-01', 1, 5000, 0, now())`,
    [m.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id) VALUES ('reporting', 999999)
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 999999`,
  );

  const summary = await withTransaction(pool, (client) => refreshAnalyticsRollups(client));

  const state = await pool.query<{ cursor: string; rows: string }>(
    `SELECT (SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = 'reporting')::text AS cursor,
            (SELECT count(*) FROM merchant_daily_volume)::text AS rows`,
  );
  // Rollups empty AND cursor back at the start: the worker will add each
  // event once. (The old bug: rollups refilled, cursor left at 999999.)
  assert.equal(state.rows[0]!.rows, "0");
  assert.equal(state.rows[0]!.cursor, "0");
  assert.equal(summary.replayQueued, true);
});

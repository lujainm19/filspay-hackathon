/**
 * New test for A6: after "Rebuild analytics", the reporting worker's cursor
 * points at the last event the rebuild already counted, so the worker won't
 * count those events a second time. Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
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

test("A6: the rebuild moves the reporting cursor up to the newest outbox event", async () => {
  await pool.query(
    `INSERT INTO reporting_outbox_cursor (consumer_name, last_processed_id) VALUES ('reporting', 0)
     ON CONFLICT (consumer_name) DO UPDATE SET last_processed_id = 0`,
  );
  await withTransaction(pool, (client) => refreshAnalyticsRollups(client));
  const result = await pool.query<{ cursor: string; newest: string }>(
    `SELECT (SELECT last_processed_id FROM reporting_outbox_cursor WHERE consumer_name = 'reporting')::text AS cursor,
            (SELECT COALESCE(MAX(id), 0) FROM outbox_events)::text AS newest`,
  );
  assert.equal(result.rows[0]!.cursor, result.rows[0]!.newest);
});

/**
 * FP-300 reporting side (partner branch): refund.succeeded reaches the
 * merchant_daily_volume rollup, on the Asia/Bahrain business day.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent } from "./applyEvent.js";
import { REPORTING_EVENT_TYPES } from "./runConsumerPass.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
test.after(async () => {
  await pool.end();
});

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`refundRollup ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

test("the reporting worker subscribes to refund.succeeded", () => {
  assert.ok(REPORTING_EVENT_TYPES.includes("refund.succeeded"));
});

test("refund.succeeded rolls up into the Bahrain business day (22:30 UTC = next day in Bahrain)", async () => {
  const merchantId = await merchant();
  for (const amountFils of [1_250, 500]) {
    await withTransaction(pool, (client) =>
      applyEvent(client, {
        id: 1,
        aggregate_id: randomUUID(),
        event_type: "refund.succeeded",
        payload: { merchantId, refundId: randomUUID(), amountFils, feeReversedFils: 0 },
        created_at: new Date("2026-03-31T22:30:00Z"),
      }),
    );
  }
  const r = await pool.query(
    `SELECT volume_date::text AS d, refund_count, refund_gross_fils::int AS g FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.deepEqual(r.rows, [{ d: "2026-04-01", refund_count: 2, g: 1_750 }]);
});

test("a malformed refund.succeeded is rejected (dead-lettered by the pass), not silently counted", async () => {
  const merchantId = await merchant();
  await assert.rejects(
    withTransaction(pool, (client) =>
      applyEvent(client, {
        id: 1,
        aggregate_id: randomUUID(),
        event_type: "refund.succeeded",
        payload: { merchantId, amountFils: "12.5" },
        created_at: new Date(),
      }),
    ),
    /malformed payload/,
  );
});

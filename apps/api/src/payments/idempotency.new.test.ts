/**
 * New test for C6: two simultaneous retries of a failed request can't both
 * proceed. Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { claimIdempotencyKey } from "./idempotency.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("idempotency.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
after(async () => {
  await pool.end();
});

test("C6: when two retries of a failed key race, only one is allowed to proceed", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Idem ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const key = randomUUID();
  const claimInput = { merchantId, endpoint: "transactions.capture", key, requestHash: "h" };
  await pool.query(
    `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status) VALUES ($1, $2, $3, 'h', 'failed')`,
    [merchantId, "transactions.capture", key],
  );

  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("BEGIN");
    await b.query("BEGIN");

    // A reads the key as 'failed', then pauses right before its UPDATE.
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => (releaseA = resolve));
    const pausingA = {
      query: async (text: string, params?: unknown[]) => {
        if (text.includes("UPDATE idempotency_keys")) await gate;
        return a.query(text, params);
      },
    } as unknown as typeof a;
    const firstPromise = claimIdempotencyKey(pausingA, claimInput);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Meanwhile B also reads 'failed' and claims the retry.
    const second = await claimIdempotencyKey(b, claimInput);
    assert.equal(second.outcome, "retry_after_failure");

    // Now A tries its UPDATE; it waits for B, B commits, A re-checks.
    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await b.query("COMMIT");
    const first = await firstPromise;
    await a.query("COMMIT");

    // Before the fix A also got retry_after_failure and would have called the
    // acquirer a second time.
    assert.equal(first.outcome, "conflict_in_progress");
  } finally {
    a.release();
    b.release();
  }
});

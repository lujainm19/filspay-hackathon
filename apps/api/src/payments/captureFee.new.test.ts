/**
 * New test for M9: the fee charged at capture uses the same formula as
 * settlement (discount off the amount, then MDR), for every capture path,
 * including payment links. Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("captureFee.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 4 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

test("M9: a payment-link capture for a discounted merchant is charged the discounted fee, in one step", async () => {
  // Alpha Retail's real terms from the seed: 275 bps MDR, 75 bps negotiated discount.
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, negotiated_discount_bps) VALUES ($1, 275, 75) RETURNING id`,
    [`Fee ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id });

  const link = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: { authorization: `Bearer ${key.rawKey}` },
    payload: { amountFils: 10_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(link.statusCode, 201, link.body);
  const paid = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.json().token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
  });
  assert.equal(paid.statusCode, 200, paid.body);

  // Settlement's formula: 10000 − 75 bps (75) = 9925; 275 bps of 9925 = 272.94 → 273.
  // Before the fix, payment links were charged the full 275 and never discounted.
  const fee = await pool.query<{ credit: string; adjustments: string }>(
    `SELECT COALESCE(SUM(amount_fils) FILTER (WHERE direction = 'credit'), 0)::text AS credit,
            count(*) FILTER (WHERE description = 'capture: negotiated discount adjustment')::text AS adjustments
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [paid.json().transactionId],
  );
  assert.equal(Number(fee.rows[0]!.credit), 273);
  assert.equal(Number(fee.rows[0]!.adjustments), 0);
});

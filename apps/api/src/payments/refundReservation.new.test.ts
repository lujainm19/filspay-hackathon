/**
 * New tests for the team's chosen refund design (C2 "option B") and the
 * API key rotation grace (A3, 24 h). Needs DATABASE_URL.
 *
 *  - while one refund is at the acquirer, its amount is reserved, so a
 *    second refund can't use the same money;
 *  - no row lock is held during the acquirer call (the reason for option B);
 *  - a refund left 'pending' by a crash is finished by recoverStuckRefunds;
 *  - a rotated API key keeps working until its 24 h overlap is over.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { toFils } from "@filspay/money";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { verifyApiKey } from "../apiKeys/verify.js";
import { rotateApiKeyAsAdmin } from "../admin/apiKeys.js";
import { recordKycReview } from "../onboarding/review.js";
import type { AcquirerRefundRequest, AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { processRefund, recoverStuckRefunds } from "./processRefund.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("refundReservation.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Reservation ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, key, actor: { type: "merchant_api_key" as const, id: key.id } };
}

async function capturedSale(rawKey: string, fils: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: fils, card: CARD },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = auth.json().id as string;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils: fils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

/** An acquirer whose refund waits until the test lets it go. */
function gatedAcquirer() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const called = new Promise<void>((r) => (reached = r));
  const acquirer = {
    async refund(req: AcquirerRefundRequest): Promise<AcquirerRefundResult> {
      reached();
      await gate;
      return { outcome: "approved", acquirerReference: `ref_${req.idempotencyKey}`, latencyMs: 0 };
    },
  } as unknown as AcquirerSimulator;
  return { acquirer, called, release };
}

const approving = {
  async refund(req: AcquirerRefundRequest): Promise<AcquirerRefundResult> {
    return { outcome: "approved", acquirerReference: `ref_${req.idempotencyKey}`, latencyMs: 0 };
  },
} as unknown as AcquirerSimulator;

test("C2 option B: a refund at the acquirer reserves its amount and holds no row lock meanwhile", async () => {
  const m = await merchantWithKey("reserve");
  const txnId = await capturedSale(m.key.rawKey, 5_000);
  const gated = gatedAcquirer();

  const first = processRefund(pool, gated.acquirer, {
    transactionId: txnId,
    merchantId: m.merchantId,
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  await gated.called; // the first refund is now "at the acquirer"

  // No lock is held on the transaction row during the network call.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT 1 FROM transactions WHERE id = $1 FOR UPDATE NOWAIT`, [txnId]);
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  // ...but its 5 BD is reserved, so a second refund can't take it too.
  const second = await processRefund(pool, approving, {
    transactionId: txnId,
    merchantId: m.merchantId,
    amountFils: toFils(5_000),
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  assert.equal(second.statusCode, 422, JSON.stringify(second.body));
  assert.equal((second.body as { code: string }).code, "refund_exceeds_refundable");

  gated.release();
  const done = await first;
  assert.equal(done.statusCode, 200, JSON.stringify(done.body));

  const row = await pool.query<{ refunded_fils: string; status: string }>(
    `SELECT refunded_fils, status FROM transactions WHERE id = $1`,
    [txnId],
  );
  assert.equal(Number(row.rows[0]!.refunded_fils), 5_000);
  assert.equal(row.rows[0]!.status, "refunded");
  const refunds = await pool.query<{ status: string }>(`SELECT status FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.deepEqual(
    refunds.rows.map((r) => r.status),
    ["succeeded"],
  );
});

test("C2 option B: a refund left pending by a crash is finished by recoverStuckRefunds", async () => {
  const m = await merchantWithKey("recover");
  const txnId = await capturedSale(m.key.rawKey, 4_000);

  // What a crash between "reserve" and "settle" leaves behind: an in_progress
  // idempotency key and a pending refund row.
  const claim = await pool.query<{ id: string }>(
    `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash, status)
     VALUES ($1, 'refunds.create', $2, 'h', 'in_progress') RETURNING id`,
    [m.merchantId, randomUUID()],
  );
  const claimId = claim.rows[0]!.id;
  const pending = await pool.query<{ id: string }>(
    `INSERT INTO refunds (transaction_id, merchant_id, amount_fils, status, acquirer_reference, reason,
                          created_by_type, created_by_id, idempotency_key_id, acquirer_idempotency_key, created_at)
     VALUES ($1, $2, 1500, 'pending', NULL, 'unspecified', 'merchant_api_key', $3, $4, $5, now() - interval '10 minutes')
     RETURNING id`,
    [txnId, m.merchantId, m.key.id, claimId, `${claimId}:1`],
  );

  const seen: string[] = [];
  const recording = {
    async refund(req: AcquirerRefundRequest): Promise<AcquirerRefundResult> {
      seen.push(req.idempotencyKey);
      return { outcome: "approved", acquirerReference: "ref_recovered", latencyMs: 0 };
    },
  } as unknown as AcquirerSimulator;
  await recoverStuckRefunds(pool, recording, 120);

  // The acquirer was asked again with the SAME key, so it can't refund twice.
  assert.deepEqual(seen, [`${claimId}:1`]);
  const refund = await pool.query<{ status: string; acquirer_reference: string }>(
    `SELECT status, acquirer_reference FROM refunds WHERE id = $1`,
    [pending.rows[0]!.id],
  );
  assert.equal(refund.rows[0]!.status, "succeeded");
  assert.equal(refund.rows[0]!.acquirer_reference, "ref_recovered");
  const txn = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txnId]);
  assert.equal(Number(txn.rows[0]!.refunded_fils), 1_500);
  const key = await pool.query<{ status: string }>(`SELECT status FROM idempotency_keys WHERE id = $1`, [claimId]);
  assert.equal(key.rows[0]!.status, "completed");
});

test("A3: a rotated API key keeps working for its 24 h overlap, then stops", async () => {
  const m = await merchantWithKey("rotate-grace");
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Rot', 'finance') RETURNING id`,
    [`rot-${randomUUID()}@admin.test`],
  );
  const rotated = await rotateApiKeyAsAdmin(pool, config, {
    merchantId: m.merchantId,
    apiKeyId: m.key.id,
    adminUserId: admin.rows[0]!.id,
  });

  // Old and new both work during the overlap.
  assert.ok(await verifyApiKey(pool, m.key.rawKey));
  assert.ok(await verifyApiKey(pool, rotated.rawKey));
  const due = await pool.query<{ hours: string }>(
    `SELECT round(extract(epoch FROM revoke_after - now()) / 3600)::text AS hours FROM api_keys WHERE id = $1`,
    [m.key.id],
  );
  assert.equal(due.rows[0]!.hours, "24");

  // Once the overlap is over the old key stops; the new one keeps working.
  await pool.query(`UPDATE api_keys SET revoke_after = now() - interval '1 second' WHERE id = $1`, [m.key.id]);
  assert.equal(await verifyApiKey(pool, m.key.rawKey), null);
  assert.ok(await verifyApiKey(pool, rotated.rawKey));
});

test("refunds: a declined refund releases its reservation so the money can still be refunded", async () => {
  const m = await merchantWithKey("decline-release");
  const txnId = await capturedSale(m.key.rawKey, 3_000);
  const declining = {
    async refund(req: AcquirerRefundRequest): Promise<AcquirerRefundResult> {
      return { outcome: "declined", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  } as unknown as AcquirerSimulator;
  const declined = await processRefund(pool, declining, {
    transactionId: txnId,
    merchantId: m.merchantId,
    amountFils: toFils(3_000),
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  assert.equal(declined.statusCode, 402);
  const ok = await processRefund(pool, approving, {
    transactionId: txnId,
    merchantId: m.merchantId,
    amountFils: toFils(3_000),
    idempotencyKey: randomUUID(),
    actor: m.actor,
  });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
});

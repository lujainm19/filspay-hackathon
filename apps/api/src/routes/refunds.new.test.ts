/**
 * New tests for FP-300 (refunds) and the bugs fixed with it: C2 (two refunds
 * at once), M14 (refund more than captured), M15 (fee reversal adding up),
 * S8 (refunding someone else's sale). Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { startImpersonation } from "../admin/impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("refunds.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  // A little acquirer latency so the "two refunds at once" test really overlaps.
  ACQUIRER_LATENCY_MIN_MS: "50",
  ACQUIRER_LATENCY_MAX_MS: "100",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 6 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant(label: string, mdrBps = 250) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Refund ${label} ${randomUUID()}`, mdrBps],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, auth: { authorization: `Bearer ${key.rawKey}` } };
}

/** Authorize `authorizeFils` and capture `captureFils` of it, through the real API. */
async function sale(m: { auth: Record<string, string> }, authorizeFils: number, captureFils = authorizeFils) {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...m.auth, "idempotency-key": randomUUID() },
    payload: { amountFils: authorizeFils, card: CARD },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = auth.json().id as string;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { ...m.auth, "idempotency-key": randomUUID() },
    payload: { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function refund(m: { merchantId: string; auth: Record<string, string> }, body: Record<string, unknown>, key = randomUUID()) {
  return app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/refunds`,
    headers: { ...m.auth, "idempotency-key": key },
    payload: body,
  });
}

async function txnRow(id: string) {
  const r = await pool.query<{ status: string; captured_fils: string; refunded_fils: string }>(
    `SELECT status, captured_fils, refunded_fils FROM transactions WHERE id = $1`,
    [id],
  );
  return r.rows[0]!;
}

test("FP-300: partial then final refund through the API — status, ledger, timeline and outbox all line up", async () => {
  const m = await merchant("flow");
  const txnId = await sale(m, 10_000);

  const first = await refund(m, { transactionId: txnId, amountFils: 4_000, reason: "item returned" });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().transactionStatus, "partially_refunded");

  const rest = await refund(m, { transactionId: txnId }); // no amount = everything left
  assert.equal(rest.statusCode, 200, rest.body);
  assert.equal(rest.json().amountFils, 6_000);
  assert.equal(rest.json().transactionStatus, "refunded");

  const row = await txnRow(txnId);
  assert.equal(Number(row.refunded_fils), 10_000);

  // Merchant payable for this sale nets to zero: gross in, fee out, all of it back.
  const payable = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'merchant_payable'`,
    [txnId],
  );
  assert.equal(Number(payable.rows[0]!.net), 0);

  const events = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM transaction_events WHERE transaction_id = $1 ORDER BY occurred_at, id`,
    [txnId],
  );
  assert.deepEqual(events.rows.map((e) => e.event_type).slice(-2), ["refund_partial", "refunded"]);

  const outbox = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM outbox_events WHERE event_type = 'refund.succeeded' AND aggregate_id = $1`,
    [txnId],
  );
  assert.equal(Number(outbox.rows[0]!.n), 2);
});

test("M14: you can't refund more than was captured, even if more was authorized", async () => {
  const m = await merchant("m14");
  const txnId = await sale(m, 10_000, 4_000); // authorized 10 BD, captured 4 BD
  const over = await refund(m, { transactionId: txnId, amountFils: 10_000 });
  assert.equal(over.statusCode, 422, over.body);
  assert.equal(over.json().code, "refund_exceeds_refundable");
  assert.equal(over.json().refundableFils, 4_000);
});

test("C2 (FP-209): two different refunds for the full amount at the same moment — only one goes through", async () => {
  const m = await merchant("c2");
  const txnId = await sale(m, 5_000);
  const results = await Promise.all([refund(m, { transactionId: txnId }), refund(m, { transactionId: txnId })]);
  const ok = results.filter((r) => r.statusCode === 200);
  assert.equal(ok.length, 1, results.map((r) => `${r.statusCode} ${r.body}`).join("\n"));
  const row = await txnRow(txnId);
  assert.equal(Number(row.refunded_fils), 5_000);
  const refunds = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM refunds WHERE transaction_id = $1`, [txnId]);
  assert.equal(Number(refunds.rows[0]!.n), 1);
});

test("M15: two half refunds give back exactly the fee charged, never more", async () => {
  // 120 fils at 250 bps = a 3-fil fee. The old per-refund rounding gave back
  // 2 + 2 = 4 fils on two 60-fil refunds.
  const m = await merchant("m15", 250);
  const txnId = await sale(m, 120);
  const fee = await pool.query<{ fee: string }>(
    `SELECT COALESCE(SUM(amount_fils), 0)::text AS fee FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue' AND direction = 'credit'`,
    [txnId],
  );
  assert.equal(Number(fee.rows[0]!.fee), 3);
  assert.equal((await refund(m, { transactionId: txnId, amountFils: 60 })).statusCode, 200);
  assert.equal((await refund(m, { transactionId: txnId, amountFils: 60 })).statusCode, 200);
  const reversed = await pool.query<{ total: string }>(
    `SELECT SUM(fee_reversed_fils)::text AS total FROM refunds WHERE transaction_id = $1`,
    [txnId],
  );
  assert.equal(Number(reversed.rows[0]!.total), 3);
});

test("S8: merchant B can't refund merchant A's sale", async () => {
  const a = await merchant("s8-a");
  const b = await merchant("s8-b");
  const txnId = await sale(a, 5_000);
  const res = await refund(b, { transactionId: txnId });
  assert.equal(res.statusCode, 404, res.body);
  assert.equal(Number((await txnRow(txnId)).refunded_fils), 0);
});

test("refund rules: Idempotency-Key required, retries replay, impersonation can't refund", async () => {
  const m = await merchant("rules");
  const txnId = await sale(m, 5_000);

  const noKey = await app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/refunds`,
    headers: m.auth,
    payload: { transactionId: txnId },
  });
  assert.equal(noKey.statusCode, 400);

  const key = randomUUID();
  const one = await refund(m, { transactionId: txnId, amountFils: 1_000 }, key);
  const two = await refund(m, { transactionId: txnId, amountFils: 1_000 }, key);
  assert.equal(one.statusCode, 200);
  assert.deepEqual(two.json(), one.json());
  assert.equal(Number((await txnRow(txnId)).refunded_fils), 1_000);

  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Imp', 'super_admin') RETURNING id`,
    [`imp-${randomUUID()}@admin.test`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId: m.merchantId, ttlMinutes: 5 });
  const imp = await app.inject({
    method: "POST",
    url: `/v1/merchants/${m.merchantId}/refunds`,
    headers: { cookie: `${config.impersonationCookieName}=${grant.rawToken}`, "idempotency-key": randomUUID() },
    payload: { transactionId: txnId },
  });
  assert.equal(imp.statusCode, 403, imp.body);
});

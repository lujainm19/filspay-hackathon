/**
 * Regression tests for the partner-branch extras (docs/FINDINGS.md). Each
 * test names the finding it pins and fails on the original code.
 * Requires DATABASE_URL (migrated).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { hashPassword } from "./auth/passwords.js";
import { recordKycReview } from "./onboarding/review.js";
import { createAcquirerSimulator } from "./acquirer/simulator.js";
import { payPaymentLink, recoverStuckPaymentLinks } from "./paymentLinks/pay.js";
import type { AcquirerSimulator } from "./acquirer/types.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("partnerRegressions.test.ts requires DATABASE_URL");

const env = {
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "0",
  ACQUIRER_LATENCY_MAX_MS: "1",
};
const config = loadConfig(env);
const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchant(label: string): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Partner ${label} ${randomUUID()}`],
  );
  await recordKycReview(pool, { merchantId: m.rows[0]!.id, outcome: "approved", reviewerIdentifier: "test" });
  return m.rows[0]!.id;
}

async function insertLink(merchantId: string) {
  const token = `plink_${randomUUID().replace(/-/g, "")}`;
  const r = await pool.query<{ id: string }>(
    `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
     VALUES ($1, $2, 1500, now() + interval '1 hour', 'merchant_api_key', $3) RETURNING id`,
    [merchantId, token, randomUUID()],
  );
  return { id: r.rows[0]!.id, token };
}

// ------------------------------------------------------------- hosting

test("Dev webhook key: the built-in fallback is a valid AES-256 key (32 bytes)", () => {
  const dev = loadConfig({ DATABASE_URL: databaseUrl, NODE_ENV: "development" });
  assert.equal(Buffer.from(dev.webhookSecretEncryptionKey, "base64").length, 32);
});

test("Health: /healthz/db is a live database probe", async () => {
  const res = await app.inject({ method: "GET", url: "/healthz/db" });
  assert.equal(res.statusCode, 200, res.body);
});

test("Load shedding: over the in-flight cap the API answers 503 + Retry-After, health is never shed", async () => {
  const tiny = buildApp({ ...config, maxInFlightRequests: 0 }, pool);
  try {
    const res = await tiny.inject({ method: "GET", url: "/v1/auth/me" });
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers["retry-after"], "1");
    const health = await tiny.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
  } finally {
    await tiny.close();
  }
});

// ------------------------------------------------------------- 10-minute logout

test("10-minute logout: OTP verify re-issues the session cookie with the full session lifetime", async () => {
  const merchantId = await merchant("cookie");
  const email = `u-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  await pool.query(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3)`,
    [merchantId, email, await hashPassword(password, config)],
  );
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  const code = (login.json() as { devOtpCode: string }).devOtpCode;
  const verify = await app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
  assert.equal(verify.statusCode, 200, verify.body);
  const setCookie = String(verify.headers["set-cookie"] ?? "");
  const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1] ?? 0);
  assert.equal(maxAge, config.sessionTtlHours * 3600, `verify must extend the cookie (got "${setCookie}")`);
});

// ------------------------------------------------------------- payment links

function declineCaptures(): AcquirerSimulator {
  const real = createAcquirerSimulator(config);
  return {
    authorize: (req) => real.authorize(req),
    refund: (req) => real.refund(req),
    async capture(req) {
      return { outcome: "declined", acquirerReference: req.acquirerReference, latencyMs: 0 };
    },
  } as AcquirerSimulator;
}

test("Failed capture on a payment link voids the authorization (no orphan card hold)", async () => {
  const merchantId = await merchant("capture-fail");
  const link = await insertLink(merchantId);
  const res = await payPaymentLink(pool, declineCaptures(), config, {
    token: link.token,
    card: CARD,
    idempotencyKey: randomUUID(),
  } as Parameters<typeof payPaymentLink>[3]);
  assert.notEqual(res.statusCode, 200);
  const txn = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE merchant_id = $1`, [merchantId]);
  assert.equal(txn.rowCount, 1);
  assert.equal(txn.rows[0]!.status, "voided", "the authorization must be voided");
  const holds = await pool.query(`SELECT 1 FROM holds WHERE merchant_id = $1 AND status = 'active'`, [merchantId]);
  assert.equal(holds.rowCount, 0, "no active card hold may remain");
  const l = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [link.id]);
  assert.equal(l.rows[0]!.status, "active", "the link is payable again");
});

test("Crash recovery: a link left mid-capture is resolved (captured -> paid, authorized -> voided + reopened)", async () => {
  const merchantId = await merchant("recovery");
  // Pay one link normally to get a real captured transaction, then rewind
  // the link to "crashed after capture, before finalize".
  const paidLink = await insertLink(merchantId);
  const ok = await payPaymentLink(pool, createAcquirerSimulator(config), config, {
    token: paidLink.token,
    card: CARD,
    idempotencyKey: randomUUID(),
  } as Parameters<typeof payPaymentLink>[3]);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  const t = await pool.query<{ transaction_id: string }>(`SELECT transaction_id FROM payment_links WHERE id = $1`, [paidLink.id]);
  await pool.query(
    `UPDATE payment_links SET status = 'reserved', paid_at = NULL, transaction_id = NULL, reserved_at = now() - interval '10 minutes',
            reservation_id = gen_random_uuid(), capture_started_at = now() - interval '10 minutes', pending_transaction_id = $2
      WHERE id = $1`,
    [paidLink.id, t.rows[0]!.transaction_id],
  );

  // A second link that crashed after authorize, before capture.
  const authLink = await insertLink(merchantId);
  const auth = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, currency, reference, acquirer_reference)
     VALUES ($1, 'authorized', 1500, 0, 'BHD', $2, $3) RETURNING id`,
    [merchantId, `ref-${randomUUID()}`, `acq_${randomUUID()}`],
  );
  await pool.query(
    `UPDATE payment_links SET status = 'reserved', reserved_at = now() - interval '10 minutes',
            reservation_id = gen_random_uuid(), capture_started_at = now() - interval '10 minutes', pending_transaction_id = $2
      WHERE id = $1`,
    [authLink.id, auth.rows[0]!.id],
  );

  const resolved = await recoverStuckPaymentLinks(pool, 120);
  assert.ok(resolved >= 2, `resolved ${resolved}`);
  const rows = await pool.query<{ id: string; status: string; transaction_id: string | null }>(
    `SELECT id, status, transaction_id FROM payment_links WHERE id = ANY($1::uuid[])`,
    [[paidLink.id, authLink.id]],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  assert.equal(byId.get(paidLink.id)!.status, "paid");
  assert.equal(byId.get(paidLink.id)!.transaction_id, t.rows[0]!.transaction_id);
  assert.equal(byId.get(authLink.id)!.status, "active");
  const voided = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [auth.rows[0]!.id]);
  assert.equal(voided.rows[0]!.status, "voided");
});

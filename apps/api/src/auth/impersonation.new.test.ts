/**
 * New tests for S13 / S14 / S15: "view as merchant" is read-only for every
 * admin role, and dies with the admin's account. Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { startImpersonation } from "../admin/impersonation.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("impersonation.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

async function setup(adminRole: "support" | "finance" | "super_admin") {
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'x', 'Impersonation Test', $2) RETURNING id`,
    [`imp-${randomUUID()}@admin.test`, adminRole],
  );
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Impersonated ${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const txn = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'authorized', 5000, 0, $2) RETURNING id`,
    [merchantId, `acqref_${randomUUID()}`],
  );
  const grant = await startImpersonation(pool, { adminUserId: admin.rows[0]!.id, merchantId, ttlMinutes: 15 });
  return {
    adminUserId: admin.rows[0]!.id,
    merchantId,
    transactionId: txn.rows[0]!.id,
    cookie: `${config.impersonationCookieName}=${grant.rawToken}`,
  };
}

test("S13/S14: a super_admin viewing as a merchant can read but can't capture, void or create links", async () => {
  const s = await setup("super_admin");

  const read = await app.inject({ method: "GET", url: `/v1/transactions/${s.transactionId}`, headers: { cookie: s.cookie } });
  assert.equal(read.statusCode, 200, read.body);

  const capture = await app.inject({
    method: "POST",
    url: `/v1/transactions/${s.transactionId}/capture`,
    headers: { cookie: s.cookie, "idempotency-key": randomUUID() },
    payload: {},
  });
  assert.equal(capture.statusCode, 403, capture.body);

  const voidRes = await app.inject({ method: "POST", url: `/v1/transactions/${s.transactionId}/void`, headers: { cookie: s.cookie } });
  assert.equal(voidRes.statusCode, 403, voidRes.body);

  const link = await app.inject({
    method: "POST",
    url: `/v1/merchants/${s.merchantId}/payment-links`,
    headers: { cookie: s.cookie },
    payload: { amountFils: 1000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(link.statusCode, 403, link.body);

  const status = await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [s.transactionId]);
  assert.equal(status.rows[0]!.status, "authorized");
});

test("S15: disabling the admin kills their 'view as merchant' grant immediately", async () => {
  const s = await setup("support");
  await pool.query(`UPDATE admin_users SET status = 'disabled' WHERE id = $1`, [s.adminUserId]);
  const read = await app.inject({ method: "GET", url: `/v1/transactions/${s.transactionId}`, headers: { cookie: s.cookie } });
  assert.equal(read.statusCode, 401, read.body);
});

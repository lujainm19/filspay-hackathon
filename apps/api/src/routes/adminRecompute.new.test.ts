/**
 * New test for T3: "Recompute transaction statuses" must never take a test
 * merchant out of test mode. Needs DATABASE_URL.
 *
 * It used to clear merchants.test_mode whenever the merchant had no open
 * authorizations, and the settlement run only skips test_mode merchants, so
 * the sandbox merchant Gamma ended up in the real settlement run.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { hashPassword } from "../adminAuth/passwords.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("adminRecompute.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  ACQUIRER_FAILURE_RATE: "0",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

function cookieFrom(setCookie: string | string[] | undefined): string {
  const all = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? "")];
  const mine = all.find((c) => c.startsWith(`${config.adminCookieName}=`))!;
  return mine.split(";")[0]!;
}

async function financeAdminCookie(): Promise<string> {
  const password = "admin-test-password-9000!";
  const email = `recompute-${randomUUID()}@admin.test`;
  await pool.query(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, 'Finance', 'finance')`,
    [email, await hashPassword(password, config)],
  );
  const login = await app.inject({ method: "POST", url: "/v1/admin/auth/login", payload: { email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const verify = await app.inject({
    method: "POST",
    url: "/v1/admin/auth/otp/verify",
    headers: { cookie: cookieFrom(login.headers["set-cookie"]) },
    payload: { code: login.json().devOtpCode },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  return cookieFrom(verify.headers["set-cookie"]);
}

test("T3: Recompute transaction statuses leaves a test merchant in test mode", async () => {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, test_mode) VALUES ($1, 250, true) RETURNING id`,
    [`Gamma sandbox ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const owner = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: owner.rows[0]!.id, label: "t3" });
  const auth = { authorization: `Bearer ${key.rawKey}` };

  // One fully captured sale, so the merchant has no open authorizations —
  // exactly the case where the old code cleared the flag.
  const authz = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils: 1_000, card: { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" } },
  });
  assert.equal(authz.statusCode, 201, authz.body);
  const capture = await app.inject({
    method: "POST",
    url: `/v1/transactions/${authz.json().id}/capture`,
    headers: { ...auth, "idempotency-key": randomUUID() },
    payload: { amountFils: 1_000 },
  });
  assert.equal(capture.statusCode, 200, capture.body);

  const res = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchantId}/transactions/recompute-statuses`,
    headers: { cookie: await financeAdminCookie() },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().flagsUpdated, []);

  const after = await pool.query<{ test_mode: boolean }>(`SELECT test_mode FROM merchants WHERE id = $1`, [merchantId]);
  assert.equal(after.rows[0]!.test_mode, true, "a test merchant must stay out of real settlement");
});

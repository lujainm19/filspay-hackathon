/**
 * New tests for the login fixes (S1, S3, S4, S16). Needs DATABASE_URL pointing
 * at a migrated Postgres, same as app.test.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("loginSecurity.new.test.ts requires DATABASE_URL");

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : (raw as string | undefined);
  if (!header) throw new Error("expected a Set-Cookie header");
  return header.split(";")[0] as string;
}

async function signupAndLogin(prefix: string) {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  const signupRes = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `Test Co ${prefix}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: `c-${randomUUID()}@example.test`,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(signupRes.statusCode, 201, signupRes.body);
  const { merchantId } = signupRes.json() as { merchantId: string };
  const loginRes = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  const { devOtpCode } = loginRes.json() as { devOtpCode: string };
  return { merchantId, pendingCookie: cookieFrom(loginRes), code: devOtpCode };
}

/** A code that is guaranteed not to match the real one. */
function wrongCode(real: string): string {
  return real === "000000" ? "111111" : "000000";
}

test("S1: the cookie from the password step alone does not authenticate anything", async () => {
  const { pendingCookie } = await signupAndLogin("s1");
  const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: pendingCookie } });
  assert.equal(me.statusCode, 401);
  const txns = await app.inject({ method: "GET", url: "/v1/transactions", headers: { cookie: pendingCookie } });
  assert.equal(txns.statusCode, 401);
});

test("S16: after the OTP, the old cookie is dead and only the new one works", async () => {
  const { pendingCookie, code } = await signupAndLogin("s16");
  const verify = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie: pendingCookie },
    payload: { code },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const newCookie = cookieFrom(verify);
  assert.notEqual(newCookie, pendingCookie);
  const oldMe = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: pendingCookie } });
  assert.equal(oldMe.statusCode, 401);
  const newMe = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: newCookie } });
  assert.equal(newMe.statusCode, 200, newMe.body);
});

test("S3: 20 wrong guesses fired at once can't use more than max_attempts tries", async () => {
  const { pendingCookie, code } = await signupAndLogin("s3");
  const guesses = Array.from({ length: 20 }, () =>
    app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { cookie: pendingCookie },
      payload: { code: wrongCode(code) },
    }),
  );
  const results = await Promise.all(guesses);
  const checked = results.filter((r) => r.statusCode === 401 && r.json().error === "invalid_code").length;
  assert.ok(checked <= config.otpMaxAttempts, `expected at most ${config.otpMaxAttempts} real checks, got ${checked}`);
  // And the right code no longer works either: the session is burnt.
  const after = await app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie: pendingCookie },
    payload: { code },
  });
  assert.notEqual(after.statusCode, 200);
});

test("S4: resending the OTP keeps the guesses already used", async () => {
  const { pendingCookie, code } = await signupAndLogin("s4");
  for (let i = 0; i < 2; i++) {
    const r = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      headers: { cookie: pendingCookie },
      payload: { code: wrongCode(code) },
    });
    assert.equal(r.statusCode, 401);
  }
  // Pretend the resend throttle (30 s) has passed.
  await pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex'))`,
    [pendingCookie.split("=")[1]],
  );
  const resend = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie: pendingCookie } });
  assert.equal(resend.statusCode, 200, resend.body);
  const row = await pool.query<{ attempt_count: number }>(
    `SELECT c.attempt_count FROM otp_challenges c
       JOIN sessions s ON s.otp_challenge_id = c.id
      WHERE s.token_hash = encode(sha256($1::bytea), 'hex')`,
    [pendingCookie.split("=")[1]],
  );
  assert.equal(row.rows[0]?.attempt_count, 2);
});

/**
 * New tests for the payment-link fixes: C1 (one link, many buyers at once),
 * S10 (a client time can't revive an expired link) and S7 (no cancelling
 * another merchant's link). Needs DATABASE_URL like the other route tests.
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
if (!databaseUrl) throw new Error("paymentLinks.new.test.ts requires DATABASE_URL");

// A deliberately slow acquirer (200–300 ms per call), so concurrent buyers
// really overlap, like Delta's slow captures did on 13–14 May.
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "200",
  ACQUIRER_LATENCY_MAX_MS: "300",
  // Even with a tiny "reservation timeout", nobody can take the link over now.
  PAYMENT_LINK_RESERVATION_TIMEOUT_SECONDS: "0",
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
    [`New Test ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const key = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, auth: { authorization: `Bearer ${key.rawKey}` } };
}

async function createLink(merchantId: string, auth: Record<string, string>) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/merchants/${merchantId}/payment-links`,
    headers: auth,
    payload: { amountFils: 12_345, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { id: string; token: string };
}

test("C1: five buyers paying one link at the same moment produce exactly one charge", async () => {
  const { merchantId, auth } = await merchantWithKey("c1");
  const link = await createLink(merchantId, auth);

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      app.inject({
        method: "POST",
        url: `/v1/payment-links/${link.token}/pay`,
        headers: { "idempotency-key": randomUUID() },
        payload: { card: CARD },
      }),
    ),
  );
  const ok = results.filter((r) => r.statusCode === 200);
  assert.equal(ok.length, 1, results.map((r) => `${r.statusCode} ${r.body}`).join("\n"));
  for (const r of results.filter((x) => x.statusCode !== 200)) {
    assert.equal(r.statusCode, 409);
    assert.ok(["payment_link_processing", "payment_link_already_paid"].includes(r.json().error));
  }

  const captures = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM transactions WHERE merchant_id = $1 AND captured_fils > 0`,
    [merchantId],
  );
  assert.equal(Number(captures.rows[0]!.n), 1);
});

test("S10: an expired link can't be paid by sending an old submittedAt", async () => {
  const { merchantId, auth } = await merchantWithKey("s10");
  const link = await createLink(merchantId, auth);
  await pool.query(`UPDATE payment_links SET expires_at = now() - interval '1 minute' WHERE id = $1`, [link.id]);

  const res = await app.inject({
    method: "POST",
    url: `/v1/payment-links/${link.token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: CARD, submittedAt: "2020-01-01T00:00:00.000Z" },
  });
  assert.equal(res.statusCode, 410, res.body);
  assert.equal(res.json().error, "payment_link_expired");
});

test("S7: merchant A can't cancel merchant B's link", async () => {
  const a = await merchantWithKey("s7-a");
  const b = await merchantWithKey("s7-b");
  const bLink = await createLink(b.merchantId, b.auth);

  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${a.merchantId}/payment-links/${bLink.id}`,
    headers: a.auth,
  });
  assert.equal(res.statusCode, 404, res.body);
  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [bLink.id]);
  assert.equal(row.rows[0]!.status, "active");
});

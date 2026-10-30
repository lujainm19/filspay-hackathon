/**
 * New tests for the webhook fixes: W1 (signature matches the raw body),
 * W2 (replays keep the delivery id and don't re-run payout side effects)
 * and the FP-300 refund webhook.
 * Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { enqueueEvent } from "@filspay/events";
import { loadConfig } from "../config.js";
import { createWebhookEndpoint } from "./create.js";
import { runDispatchPass } from "./dispatcher.js";
import { replayWebhookDelivery } from "./replay.js";
import { WEBHOOK_DELIVERY_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "./headers.js";
import type { WebhookTransport, WebhookTransportRequest } from "./transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("dispatcher.new.test.ts requires DATABASE_URL");
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  WEBHOOK_MAX_ATTEMPTS: "3",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => {
  await pool.end();
});

/** Records only the requests sent to this test's own unique URL. */
function recorder(url: string) {
  const sent: WebhookTransportRequest[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url) sent.push(req);
    return { statusCode: 200, body: "ok" };
  };
  return { sent, transport };
}

async function merchantWithEndpoint(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Dispatcher New ${label} ${randomUUID()}`],
  );
  const url = `http://receiver-${randomUUID()}.test/hook`;
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId: m.rows[0]!.id,
    url,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  return { merchantId: m.rows[0]!.id, endpoint, url };
}

test("W1 (FP-240): the signature verifies over the exact raw body that was sent", async () => {
  const { merchantId, endpoint, url } = await merchantWithEndpoint("w1");
  await enqueueEvent(pool, {
    eventType: "transaction.captured",
    aggregateType: "transaction",
    aggregateId: randomUUID(),
    // Keys deliberately not in alphabetical order.
    payload: { merchantId, newStatus: "captured", feeFils: 71, amountCapturedFils: 4_750, capturedTotalFils: 4_750 },
  });
  const { sent, transport } = recorder(url);
  await runDispatchPass(pool, transport, config);
  assert.equal(sent.length, 1);
  const req = sent[0]!;
  const header = req.headers[WEBHOOK_SIGNATURE_HEADER]!;
  const [tPart, vPart] = header.split(",");
  const t = tPart!.slice(2);
  // What any merchant does: HMAC of "<t>.<raw body bytes>", no re-parsing.
  const expected = createHmac("sha256", endpoint.secret).update(`${t}.${req.body}`).digest("hex");
  assert.equal(vPart!.slice(3), expected);
});

test("FP-300: refund.succeeded is delivered to the merchant with the refund details", async () => {
  const { merchantId, url } = await merchantWithEndpoint("refund");
  const transactionId = randomUUID();
  await enqueueEvent(pool, {
    eventType: "refund.succeeded",
    aggregateType: "transaction",
    aggregateId: transactionId,
    payload: { merchantId, refundId: "r-1", amountFils: 1_000, feeReversedFils: 25, refundedTotalFils: 1_000, newStatus: "partially_refunded" },
  });
  const { sent, transport } = recorder(url);
  await runDispatchPass(pool, transport, config);
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0]!.body);
  assert.equal(body.type, "refund.succeeded");
  assert.deepEqual(body.data, {
    transactionId,
    merchantId,
    refundId: "r-1",
    amountFils: 1_000,
    feeReversedFils: 25,
    refundedTotalFils: 1_000,
    transactionStatus: "partially_refunded",
  });
});

test("W2: a replay keeps the original Webhook-Delivery-Id, and a replayed settlement.paid records no second disbursement", async () => {
  const { merchantId, endpoint, url } = await merchantWithEndpoint("w2");
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils)
     VALUES ($1, '2026-09-01', 'paid', 10000, 250, 9750) RETURNING id`,
    [merchantId],
  );
  const batchId = batch.rows[0]!.id;
  await enqueueEvent(pool, {
    eventType: "settlement.paid",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-09-01", netPayoutFils: 9_750 },
  });
  const { sent, transport } = recorder(url);
  await runDispatchPass(pool, transport, config);
  assert.equal(sent.length, 1);
  const originalId = sent[0]!.headers[WEBHOOK_DELIVERY_ID_HEADER];

  const original = await pool.query<{ id: string }>(
    `SELECT id FROM webhook_deliveries WHERE endpoint_id = $1 AND replay_of_delivery_id IS NULL`,
    [endpoint.id],
  );
  await replayWebhookDelivery(pool, { merchantId, endpointId: endpoint.id, deliveryId: original.rows[0]!.id });
  await runDispatchPass(pool, transport, config);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.headers[WEBHOOK_DELIVERY_ID_HEADER], originalId);

  const disbursements = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`,
    [batchId],
  );
  assert.equal(Number(disbursements.rows[0]!.n), 1);
});

test("C4: a merchant with two webhook endpoints gets settlement.paid on both, and the batch gets one disbursement", async () => {
  // 0073 made disbursements one-per-batch, but the effect still ran once per
  // delivery row (one per endpoint), so the second endpoint's delivery threw
  // on the unique index and was retried forever without ever being sent.
  const { merchantId, url } = await merchantWithEndpoint("c4");
  const secondUrl = `http://receiver-${randomUUID()}.test/hook`;
  await createWebhookEndpoint(pool, config, {
    merchantId,
    url: secondUrl,
    createdByType: "merchant_session",
    createdById: randomUUID(),
  });
  const batch = await pool.query<{ id: string }>(
    `INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils)
     VALUES ($1, '2026-09-02', 'paid', 10000, 250, 9750) RETURNING id`,
    [merchantId],
  );
  const batchId = batch.rows[0]!.id;
  await enqueueEvent(pool, {
    eventType: "settlement.paid",
    aggregateType: "settlement_batch",
    aggregateId: batchId,
    payload: { merchantId, batchId, batchDate: "2026-09-02", netPayoutFils: 9_750 },
  });
  const sent: string[] = [];
  const transport: WebhookTransport = async (req) => {
    if (req.url === url || req.url === secondUrl) sent.push(req.url);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);
  assert.deepEqual([...sent].sort(), [url, secondUrl].sort());
  const disbursements = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`,
    [batchId],
  );
  assert.equal(Number(disbursements.rows[0]!.n), 1);
});

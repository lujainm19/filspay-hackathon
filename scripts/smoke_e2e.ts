#!/usr/bin/env -S npx tsx
/**
 * End-to-end smoke test against a running deployment (what the judges'
 * demo asks for): health, checkout via a payment link, a FULL refund and a
 * PARTIAL refund, and the amounts the merchant sees afterwards.
 *
 *   BASE_URL=http://<server> MERCHANT_ID=... API_KEY=... npx tsx scripts/smoke_e2e.ts
 *
 * Exits 1 if any check fails. Creates real (test) payments on that server.
 */
import { randomUUID } from "node:crypto";

const BASE = (process.env.BASE_URL ?? "http://localhost").replace(/\/$/, "");
const KEY = process.env.API_KEY ?? "";
const MERCHANT = process.env.MERCHANT_ID ?? "";
if (!KEY || !MERCHANT) throw new Error("set MERCHANT_ID and API_KEY (see scripts/demo_key.ts)");
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
const bd = (fils: number) => `${(fils / 1000).toFixed(3)} BD`;

async function call(method: string, path: string, body?: unknown, auth = true) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${KEY}`;
  if (method === "POST") headers["idempotency-key"] = randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function checkout(amountFils: number): Promise<string> {
  const link = await call("POST", `/v1/merchants/${MERCHANT}/payment-links`, {
    amountFils,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    reference: `smoke-${Date.now()}`,
  });
  check(`create payment link for ${bd(amountFils)}`, link.status === 201, `HTTP ${link.status}`);
  const token = link.json?.token as string;
  const view = await call("GET", `/v1/payment-links/${token}`, undefined, false);
  check("buyer opens the checkout link", view.status === 200, `HTTP ${view.status}`);
  const pay = await call("POST", `/v1/payment-links/${token}/pay`, { card: CARD }, false);
  check("buyer pays", pay.status === 200, `HTTP ${pay.status}`);
  const txnId = (pay.json?.transactionId ?? pay.json?.transaction?.id ?? pay.json?.id) as string;
  check("payment returned a transaction id", typeof txnId === "string", JSON.stringify(pay.json).slice(0, 120));
  return txnId;
}

async function txn(id: string) {
  const r = await call("GET", `/v1/transactions/${id}`);
  return r.json as { status: string; capturedFils?: number; refundedFils?: number; refundedTotalFils?: number };
}

const health = await call("GET", "/healthz/db", undefined, false);
check("database health check", health.status === 200, `HTTP ${health.status}`);

// Full refund
const fullTxn = await checkout(4_750);
const full = await call("POST", `/v1/merchants/${MERCHANT}/refunds`, { transactionId: fullTxn, reason: "smoke: full" });
check("full refund accepted", full.status === 200 || full.status === 201, `HTTP ${full.status} ${JSON.stringify(full.json).slice(0, 120)}`);
check("full refund amount is 4.750 BD", full.json?.amountFils === 4_750, `got ${full.json?.amountFils}`);
check("transaction is now 'refunded'", (await txn(fullTxn)).status === "refunded");
const again = await call("POST", `/v1/merchants/${MERCHANT}/refunds`, { transactionId: fullTxn });
check("a second refund of the same payment is refused", again.status >= 400, `HTTP ${again.status}`);

// Partial refund
const partTxn = await checkout(10_000);
const part = await call("POST", `/v1/merchants/${MERCHANT}/refunds`, { transactionId: partTxn, amountFils: 2_500, reason: "smoke: partial" });
check("partial refund of 2.500 BD accepted", part.status === 200 || part.status === 201, `HTTP ${part.status}`);
check("partial refund amount is 2.500 BD", part.json?.amountFils === 2_500, `got ${part.json?.amountFils}`);
check("transaction is now 'partially_refunded'", (await txn(partTxn)).status === "partially_refunded");
const over = await call("POST", `/v1/merchants/${MERCHANT}/refunds`, { transactionId: partTxn, amountFils: 9_000 });
check("refunding more than what's left (9.000 of 7.500) is refused", over.status >= 400, `HTTP ${over.status}`);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

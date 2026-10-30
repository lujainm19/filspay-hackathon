/**
 * Unit tests for the inbound acquirer-callback signature verifier. Pure
 * function, no database — the route-level behavior it drives is covered in
 * routes/acquirerCallbacks.test.ts.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { verifyAcquirerCallbackSignature } from "./inboundVerify.js";

const SECRET = "acqsec_test_secret";

/** Builds the header the acquirer would send for a given payload — the same
 *  `t=<seconds>,v1=<hex>` shape webhooks/sign.ts uses outbound. */
// S11: signatures must be fresh now, so default to the current time.
function acquirerHeader(payload: unknown, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

test("a correctly-signed callback verifies", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, acquirerHeader(payload, SECRET), SECRET);
  assert.deepEqual(result, { valid: true });
});

test("a tampered payload is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, SECRET);
  const result = verifyAcquirerCallbackSignature({ callbackId: "acqcb_1", outcome: "confirmed_fraud" }, header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("the wrong secret is rejected (signature_mismatch)", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const header = acquirerHeader(payload, "acqsec_someone_elses_secret");
  const result = verifyAcquirerCallbackSignature(payload, header, SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("a malformed header is rejected (malformed_header)", () => {
  const payload = { callbackId: "acqcb_1" };
  assert.equal(verifyAcquirerCallbackSignature(payload, "not-a-real-header", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(payload, "t=abc,v1=deadbeef", SECRET).reason, "malformed_header");
  assert.equal(verifyAcquirerCallbackSignature(payload, "v1=deadbeef", SECRET).reason, "malformed_header");
});

test("an unsigned callback is accepted while signature checking is optional", () => {
  const payload = { callbackId: "acqcb_1", outcome: "cleared" };
  const result = verifyAcquirerCallbackSignature(payload, undefined, SECRET);
  assert.deepEqual(result, { valid: true });
});

test("S11: a correctly-signed but stale callback (10 minutes old) is rejected", () => {
  const payload = { callbackId: "acqcb_old", outcome: "cleared" };
  const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
  const result = verifyAcquirerCallbackSignature(payload, acquirerHeader(payload, SECRET, tenMinutesAgo), SECRET, true);
  assert.deepEqual(result, { valid: false, reason: "stale_timestamp" });
});

test("S11: with signatures required, a missing header is rejected", () => {
  const result = verifyAcquirerCallbackSignature({ callbackId: "x" }, undefined, SECRET, true);
  assert.equal(result.valid, false);
});

test("S11: the check runs over the exact raw body string that was sent", () => {
  const raw = '{"outcome":"cleared","callbackId":"acqcb_raw"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex");
  assert.deepEqual(verifyAcquirerCallbackSignature(raw, `t=${t},v1=${sig}`, SECRET, true), { valid: true });
});

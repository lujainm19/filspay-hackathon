import assert from "node:assert/strict";
import { test } from "node:test";
import { expiryReferenceTime } from "./pay.js";

// Tolerance for comparing a freshly-minted Date against the test's own
// `Date.now()` — generous enough not to flake on a loaded CI box.
const TOLERANCE_MS = 5_000;

test("expiryReferenceTime: no value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime();
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

test("expiryReferenceTime: empty string -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("");
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

// S10 / FP-187: this test used to lock in the bug — it checked that a time
// sent by the client was trusted. A client-supplied time must never decide
// expiry, so a past timestamp now has no effect and the server clock is used.
test("expiryReferenceTime: a client-supplied timestamp is ignored (server clock wins)", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("2026-03-14T09:30:00.000Z");
  assert.ok(resolved.getTime() >= before && resolved.getTime() <= Date.now());
});

test("expiryReferenceTime: an unparseable value -> the server's own clock", () => {
  const before = Date.now();
  const resolved = expiryReferenceTime("not-a-timestamp");
  assert.ok(!Number.isNaN(resolved.getTime()));
  assert.ok(Math.abs(resolved.getTime() - before) < TOLERANCE_MS);
});

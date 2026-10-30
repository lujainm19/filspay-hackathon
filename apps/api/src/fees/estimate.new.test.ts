/** R10: the fallback fee estimate uses integer fils and capture's formula. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRateFils, toFils } from "@filspay/money";
import { estimateFeeFils } from "./estimate.js";

test("R10: estimateFeeFils matches capture's integer formula (discount off the amount, then MDR)", () => {
  for (const [amount, mdr, discount] of [
    [4_750, 250, 0],
    [4_750, 250, 1_000],
    [100, 250, 0], // 2.5 fils -> half-to-even = 2 (float Math.round said 3)
    [123_457, 275, 500],
  ] as const) {
    const discounted = amount - applyRateFils(toFils(amount), discount);
    const expected = applyRateFils(toFils(discounted), mdr);
    assert.equal(estimateFeeFils(amount, mdr, discount), expected, `${amount} @ ${mdr}bps, -${discount}bps`);
    assert.ok(Number.isInteger(estimateFeeFils(amount, mdr, discount)));
  }
  assert.equal(estimateFeeFils(100, 250, 0), 2);
});

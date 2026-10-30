import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { assertDistinctApprover } from "./creditApproval.js";
import { AppError } from "../lib/errors.js";

test("an operator cannot approve their own credit request", () => {
  const actor = { adminUserId: randomUUID(), displayName: "Dana Finance" };
  assert.throws(
    () => assertDistinctApprover(actor, actor),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "self_approval_forbidden");
      return true;
    },
  );
});

test("two different operators satisfy two-person control", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover(
      { adminUserId: randomUUID(), displayName: "Dana Finance" },
      { adminUserId: randomUUID(), displayName: "Omar Treasury" },
    ),
  );
});

test("A4: the same person can't approve their own credit after a rename", () => {
  const id = randomUUID();
  assert.throws(
    () => assertDistinctApprover({ adminUserId: id, displayName: "Dana Finance" }, { adminUserId: id, displayName: "Dana F." }),
    /self_approval_forbidden/,
  );
});

test("A4: two different people who happen to share a name can approve each other", () => {
  assert.doesNotThrow(() =>
    assertDistinctApprover(
      { adminUserId: randomUUID(), displayName: "Ali Hasan" },
      { adminUserId: randomUUID(), displayName: "Ali Hasan" },
    ),
  );
});

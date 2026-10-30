import assert from "node:assert/strict";
import { test } from "node:test";
import { buildExpiredHoldsDelete } from "./expire_holds.js";

test("the delete is scoped to exactly the ids it was handed", () => {
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"];
  const { text, values } = buildExpiredHoldsDelete(ids);
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[])");
  assert.deepEqual(values, [ids]);
});

test("a single id still goes through the array predicate rather than a bare equality", () => {
  const { text, values } = buildExpiredHoldsDelete(["33333333-3333-3333-3333-333333333333"]);
  assert.equal(text, "DELETE FROM holds WHERE id = ANY($1::uuid[])");
  assert.equal((values[0] as string[]).length, 1);
});


// R3 regressions (partner branch).
import { buildDelete, buildWhere } from "./lib/sqlFilter.js";
import { EXPIRE_HOLDS_SQL } from "./expire_holds.js";

test("R3: an empty id list matches nothing — never an unfiltered DELETE", () => {
  const { text } = buildExpiredHoldsDelete([]);
  assert.equal(text, "DELETE FROM holds WHERE FALSE");
  assert.equal(buildWhere({ id: [] }).clause, "WHERE FALSE");
});

test("R3: buildDelete refuses to build a DELETE with no predicate", () => {
  assert.throws(() => buildDelete("holds", {}), /unfiltered DELETE/);
});

test("R3: the sweep is one atomic UPDATE guarded by status and expiry", () => {
  assert.match(EXPIRE_HOLDS_SQL, /^UPDATE holds SET status = 'expired'/);
  assert.match(EXPIRE_HOLDS_SQL, /status = 'active' AND expires_at < now\(\)/);
  assert.doesNotMatch(EXPIRE_HOLDS_SQL, /DELETE/);
});

/**
 * New test for S9: a merchant can only read a split child's report if that
 * child is *theirs*. Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { resolveReportMerchantId } from "./scope.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("scope.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(async () => {
  await pool.end();
});

async function merchant(label: string): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [
    `${label} ${randomUUID()}`,
  ]);
  return r.rows[0]!.id;
}

test("S9: another marketplace's split child can't be read; your own child can", async () => {
  const parent = await merchant("Delta Marketplace");
  const stranger = await merchant("Other merchant");
  const child = await merchant("Delta child");
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps) VALUES ($1, $2, 10000)`,
    [parent, child],
  );
  // The old check only asked "is this some parent's child?" — so the stranger got the child's data.
  assert.equal(await resolveReportMerchantId(pool, stranger, child), stranger);
  assert.equal(await resolveReportMerchantId(pool, parent, child), child);
});

/**
 * New tests for M1 (BD amounts parsed as three-decimal fils) and M2 (the same
 * import can't be applied twice). Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { applyAdjustmentImport } from "./adjustmentImport.js";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("adjustmentImport.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
after(async () => {
  await pool.end();
});

test("M1: BD amounts from finance's sheet become the right number of fils", () => {
  assert.equal(parseAdjustmentAmountFils("4.75"), 4_750); // was 475
  assert.equal(parseAdjustmentAmountFils("4.750"), 4_750);
  assert.equal(parseAdjustmentAmountFils("4.755"), 4_755); // was truncated
  assert.equal(parseAdjustmentAmountFils("120.00"), 120_000);
  assert.equal(parseAdjustmentAmountFils("-3.5"), -3_500);
  // A fourth decimal is a mistake in the sheet, so it's refused, not cut off.
  assert.throws(() => parseAdjustmentAmountFils("4.7555"), /could not parse amount/);
});

test("M2: importing the exact same rows twice is refused and posts nothing the second time", async () => {
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'x', 'Dup Import Test', 'finance') RETURNING id`,
    [`dup-${randomUUID()}@admin.test`],
  );
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status, test_mode) VALUES ($1, 250, 'active', false) RETURNING id`,
    [`dup-import-${randomUUID()}`],
  );
  const merchantId = merchant.rows[0]!.id;
  const input = {
    adminUserId: admin.rows[0]!.id,
    originalFilename: "aug-adjustments-v3-FINAL.csv",
    rows: [{ merchantId, amount: "4.75", reason: "statement correction" }],
  };

  await applyAdjustmentImport(pool, input);
  await assert.rejects(() => applyAdjustmentImport(pool, input), /already been imported/);
  // Same file submitted twice at the same moment: only one can win.
  const rowsB = [{ merchantId, amount: "1.00", reason: "double click" }];
  const results = await Promise.allSettled([
    applyAdjustmentImport(pool, { ...input, rows: rowsB }),
    applyAdjustmentImport(pool, { ...input, rows: rowsB }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

  const net = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)::text AS net
       FROM ledger_entries WHERE merchant_id = $1 AND account_id = 'merchant_payable'`,
    [merchantId],
  );
  assert.equal(Number(net.rows[0]!.net), 5_750); // 4.750 + 1.000 BD, each once
});

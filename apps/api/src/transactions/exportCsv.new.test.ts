/**
 * New tests for R4 (streamed export, no skipped rows) and S21 (no formula
 * injection). Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildTransactionsExportCsv } from "./exportCsv.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("exportCsv.new.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
after(async () => {
  await pool.end();
});

async function merchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Export ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

test("R4: 2,500 rows that share one timestamp are all exported across pages", async () => {
  const merchantId = await merchant();
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 1000, 1000, 'acq_' || g, '2026-09-01T10:00:00Z'
       FROM generate_series(1, 2500) g`,
    [merchantId],
  );
  const csv = await buildTransactionsExportCsv(pool, { merchantId });
  const lines = csv.split("\n");
  assert.equal(lines.length, 1 + 2500);
  assert.equal(new Set(lines.slice(1).map((l) => l.split(",")[0])).size, 2500);
});

test("R4: rows created with now() (microsecond timestamps) don't make paging loop forever", async () => {
  const merchantId = await merchant();
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     SELECT $1, 'captured', 1000, 1000, 'acq_now_' || g FROM generate_series(1, 1500) g`,
    [merchantId],
  );
  const csv = await buildTransactionsExportCsv(pool, { merchantId });
  assert.equal(csv.split("\n").length, 1 + 1500);
});

test("S21: a reference that looks like a spreadsheet formula is exported as plain text", async () => {
  const merchantId = await merchant();
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference)
     VALUES ($1, 'captured', 1000, 1000, '=HYPERLINK("http://evil.test","x")', 'acq_formula')`,
    [merchantId],
  );
  const csv = await buildTransactionsExportCsv(pool, { merchantId });
  const row = csv.split("\n")[1]!;
  assert.ok(row.includes(`"'=HYPERLINK(""http://evil.test"",""x"")"`), row);
});

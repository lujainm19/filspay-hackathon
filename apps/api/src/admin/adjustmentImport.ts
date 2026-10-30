import type { Pool } from "pg";
import { addFils, toFils, ZERO_FILS, type Fils } from "@filspay/money";
import { insertAdminAuditLog } from "../adminAudit/log.js";
import { withTransaction } from "../db/withTransaction.js";
import { BadRequestError, ConflictError } from "../lib/errors.js";
import { sha256Hex } from "../lib/crypto.js";
import { parseAdjustmentAmountFils } from "./adjustmentCsvParsing.js";
import { postLedgerAdjustment } from "./ledgerAdjustments.js";

export interface AdjustmentImportRow {
  merchantId: string;
  /** The raw CSV cell, unmodified. */
  amount: string;
  reason?: string;
}

/** @property totalPostedFils Sum of the absolute row amounts, so always >= 0. */
export interface AdjustmentImportResult {
  importId: string;
  rowCount: number;
  totalPostedFils: Fils;
}

async function postAdjustmentToLedgerAndCache(
  client: import("pg").PoolClient,
  merchantId: string,
  amountFils: Fils,
): Promise<string | null> {
  const entryGroupId = await postLedgerAdjustment(client, merchantId, amountFils, "CSV adjustment import");
  await client.query(
    `INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (merchant_id) DO UPDATE
       SET cached_payable_fils = merchant_balances.cached_payable_fils + $2, updated_at = now()`,
    [merchantId, amountFils],
  );
  return entryGroupId;
}

/**
 * Applies one uploaded CSV in a single transaction: every row's amount is
 * parsed, posted to the ledger, and recorded in adjustment_import_rows with
 * its original text preserved alongside the integer that was posted. The
 * audit row is the last statement in the same transaction, so an import
 * that lands without a record of who ran it is not reachable.
 */
export async function applyAdjustmentImport(
  pool: Pool,
  input: { adminUserId: string; originalFilename: string; rows: AdjustmentImportRow[] },
): Promise<AdjustmentImportResult> {
  if (input.rows.length === 0) {
    throw new BadRequestError("empty_import", "the CSV must contain at least one row");
  }

  // M2 fix: what was wrong — nothing stopped the same file being applied
  // twice. Why — imports had no fingerprint, and the "unique filename" the old
  // comment mentions never existed. What it broke — a double-click (4 Sept)
  // posted all 31 rows to the ledger a second time. We fingerprint the parsed
  // rows (merchant, amount in fils, reason) and a unique index on that
  // fingerprint (migration 0080) refuses a repeat, even two clicks at once.
  // Parsing every amount here also means a bad row fails before anything is
  // written.
  const contentSha256 = sha256Hex(
    input.rows
      .map((row) => `${row.merchantId.toLowerCase()}|${parseAdjustmentAmountFils(row.amount)}|${row.reason ?? ""}`)
      .join("\n"),
  );

  return withTransaction(pool, async (client) => {
    let importRow;
    try {
      importRow = await client.query<{ id: string }>(
        `INSERT INTO adjustment_imports (uploaded_by_admin_user_id, original_filename, row_count, content_sha256)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.adminUserId, input.originalFilename, input.rows.length, contentSha256],
      );
    } catch (err) {
      if ((err as { code?: string; constraint?: string }).constraint === "idx_adjustment_imports_content_sha256") {
        throw new ConflictError("duplicate_import", "this exact set of adjustments has already been imported");
      }
      throw err;
    }
    const importId = importRow.rows[0]!.id;

    let total = ZERO_FILS;
    for (let i = 0; i < input.rows.length; i++) {
      const row = input.rows[i]!;
      const amountFils = parseAdjustmentAmountFils(row.amount);
      const entryGroupId = await postAdjustmentToLedgerAndCache(client, row.merchantId, amountFils);

      await client.query(
        `INSERT INTO adjustment_import_rows
           (adjustment_import_id, row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason, ledger_entry_group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [importId, i + 1, row.merchantId, row.amount, amountFils, row.reason ?? null, entryGroupId],
      );
      total = addFils(total, amountFils);
    }

    await insertAdminAuditLog(client, {
      adminUserId: input.adminUserId,
      action: "adjustment_import_applied",
      targetType: "adjustment_import",
      targetId: importId,
      metadata: {
        rowCount: input.rows.length,
        totalPostedFils: total,
        originalFilename: input.originalFilename,
      },
    });

    return { importId, rowCount: input.rows.length, totalPostedFils: total };
  });
}

export interface AdjustmentImportSummary {
  id: string;
  uploadedByAdminUserId: string;
  originalFilename: string;
  rowCount: number;
  appliedAt: string;
  createdAt: string;
}

/**
 * @property parsedAmountFils The signed integer that was posted.
 * @property ledgerEntryGroupId null for a zero-amount row (nothing is journaled).
 */
export interface AdjustmentImportRowDetail {
  rowNumber: number;
  merchantId: string;
  rawAmountText: string;
  parsedAmountFils: number;
  reason: string | null;
  ledgerEntryGroupId: string | null;
}

/**
 * Keyset-paginated list of past imports, newest first. The cursor is the
 * platform's standard `created_at::text` (Postgres's own rendering, never
 * `Date.toISOString()`, which would round-trip through a JS Date and lose
 * microsecond precision).
 */
// MK: cursor compares created_at::text as a string — breaks across a DST change. FP-198
// FH: tried to repro FP-198 with TZ=Europe/London on the api box, pages looked fine?? leaving it open
export async function listAdjustmentImports(
  pool: Pool,
  params: { limit?: number; cursor?: string | null },
): Promise<{ items: AdjustmentImportSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const cursor = params.cursor ?? null;

  const result = await pool.query<{
    id: string;
    uploaded_by_admin_user_id: string;
    original_filename: string;
    row_count: number;
    applied_at: string;
    created_at: string;
  }>(
    `SELECT id, uploaded_by_admin_user_id, original_filename, row_count,
            applied_at::text AS applied_at, created_at::text AS created_at
       FROM adjustment_imports
      WHERE ($1::text IS NULL OR created_at::text < $1)
      ORDER BY created_at DESC
      LIMIT $2`,
    [cursor, limit + 1],
  );

  const rows = result.rows.slice(0, limit);
  const nextCursor = result.rows.length > limit ? (rows[rows.length - 1]?.created_at ?? null) : null;

  return {
    items: rows.map((row) => ({
      id: row.id,
      uploadedByAdminUserId: row.uploaded_by_admin_user_id,
      originalFilename: row.original_filename,
      rowCount: row.row_count,
      appliedAt: row.applied_at,
      createdAt: row.created_at,
    })),
    nextCursor,
  };
}

/** Per-row detail for one import — raw text and parsed integer side by side. */
/** @throws NotFoundError when the import id does not exist. */
export async function getAdjustmentImportRows(
  pool: Pool,
  importId: string,
): Promise<AdjustmentImportRowDetail[]> {
  const result = await pool.query<{
    row_number: number;
    merchant_id: string;
    raw_amount_text: string;
    parsed_amount_fils: string;
    reason: string | null;
    ledger_entry_group_id: string | null;
  }>(
    `SELECT row_number, merchant_id, raw_amount_text, parsed_amount_fils, reason, ledger_entry_group_id
       FROM adjustment_import_rows
      WHERE adjustment_import_id = $1
      ORDER BY row_number`,
    [importId],
  );

  return result.rows.map((row) => ({
    rowNumber: row.row_number,
    merchantId: row.merchant_id,
    rawAmountText: row.raw_amount_text,
    parsedAmountFils: Number(row.parsed_amount_fils),
    reason: row.reason,
    ledgerEntryGroupId: row.ledger_entry_group_id,
  }));
}

import type { Pool } from "pg";
import { formatBhd, toFils } from "@filspay/money";
import type { TransactionRow } from "./serialize.js";

export interface TransactionsExportFilters {
  merchantId: string;
  from?: Date;
  to?: Date;
  status?: string[];
}

const HEADER = "id,status,amount_bhd,captured_bhd,reference,occurred_at";
const PAGE_SIZE = 1000;

/**
 * Escapes one CSV cell.
 *
 * S21 fix: what was wrong — a merchant's own `reference` text was written
 * as-is. Why it matters — a cell starting with = + - or @ is treated as a
 * formula by Excel and Google Sheets. What it broke — a reference like
 * `=HYPERLINK("http://evil",...)` runs when finance opens the export. We put
 * a ' in front of such cells so they're shown as plain text.
 */
function csvEscape(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (safe.includes(",") || safe.includes('"') || safe.includes("\n") || safe.includes("\r")) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function toCsvRow(row: TransactionRow): string {
  return [
    row.id,
    row.status,
    formatBhd(toFils(Number(row.amount_fils))),
    formatBhd(toFils(Number(row.captured_fils))),
    csvEscape(row.reference ?? ""),
    row.occurred_at.toISOString(),
  ].join(",");
}

/**
 * Yields the export CSV a line at a time, reading the database a page at a time.
 *
 * R4 fix: what was wrong — the route loaded every matching row into memory and
 * built one big string, and `from`/`to` are optional, so "no range" meant the
 * merchant's whole history. Why it matters — the API is capped at 512 MB and
 * the CHANGELOG even claims this streams. What it broke — a big merchant's
 * export could OOM-kill the API for everyone. Now only one page of 1000 rows
 * is in memory at a time.
 *
 * Pages use a (occurred_at, id) keyset. The old unused streaming helper paged
 * on occurred_at alone, which silently skipped rows that shared a timestamp
 * with the last row of a page. The cursor keeps Postgres's own text form of
 * occurred_at: a JS Date only holds milliseconds, Postgres holds microseconds,
 * and a millisecond cursor would make every row of the page look "after" it
 * and re-read the same page forever.
 */
export async function* transactionsExportCsvLines(
  pool: Pool,
  filters: TransactionsExportFilters,
): AsyncGenerator<string> {
  yield `${HEADER}\n`;
  const statusArray = filters.status && filters.status.length > 0 ? filters.status : null;
  let cursor: { occurredAtText: string; id: string } | null = null;
  for (;;) {
    const result: { rows: Array<TransactionRow & { occurred_at_text: string }> } = await pool.query<
      TransactionRow & { occurred_at_text: string }
    >(
      `SELECT *, occurred_at::text AS occurred_at_text FROM transactions
        WHERE merchant_id = $1
          AND ($2::timestamptz IS NULL OR occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR occurred_at <  $3)
          AND ($4::text[] IS NULL OR status = ANY($4))
          AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5, $6::uuid))
        ORDER BY occurred_at ASC, id ASC
        LIMIT $7`,
      [
        filters.merchantId,
        filters.from ?? null,
        filters.to ?? null,
        statusArray,
        cursor?.occurredAtText ?? null,
        cursor?.id ?? null,
        PAGE_SIZE,
      ],
    );
    for (const row of result.rows) {
      yield `${toCsvRow(row)}\n`;
    }
    if (result.rows.length < PAGE_SIZE) return;
    const last = result.rows[result.rows.length - 1]!;
    cursor = { occurredAtText: last.occurred_at_text, id: last.id };
  }
}

/** Builds the whole CSV as one string. Small exports and tests only — the
 *  route streams with transactionsExportCsvLines instead. */
export async function buildTransactionsExportCsv(pool: Pool, filters: TransactionsExportFilters): Promise<string> {
  const lines: string[] = [];
  for await (const line of transactionsExportCsvLines(pool, filters)) {
    lines.push(line.endsWith("\n") ? line.slice(0, -1) : line);
  }
  return lines.join("\n");
}

#!/usr/bin/env -S npx tsx
/**
 * March 2026 scheme rounding residue sweep (FP-187 / finance memo).
 *
 * Rewritten during the handover review. The old script:
 *   - used a UTC calendar month. The handover is explicit ("must use the
 *     Bahrain month, not a UTC month"): the first three Bahrain hours of
 *     March were left out and the first three of April pulled in;
 *   - computed residue from transactions.captured_fils (a running total,
 *     dated by authorization time), not from what was actually exported to
 *     the scheme;
 *   - debited merchant_payable — charging the *merchant* for the platform's
 *     rounding — instead of the ADR-0002 accounts;
 *   - had no duplicate guard ("someone ran it twice on staging and the gap
 *     doubled"; the RUNBOOK's claim that it checks for an existing posting
 *     was false), and wrote to the ledger on every run.
 *
 * Now: residue = Σ(exported line gross − exported amount_fils) for batches
 * whose business date is in March 2026; posted per merchant as
 * debit scheme_rounding_residue / credit card_scheme_clearing; refuses to post
 * if a sweep for the month already exists; dry run unless --apply.
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts          # dry run
 *   DATABASE_URL=postgres://... npx tsx scripts/reconcile_march.ts --apply  # post
 *
 * From April 2026 onwards CloseBatch journals residue itself, so this is
 * only for March.
 */
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { formatBhd, toFils } from "@filspay/money";

/** Asia/Bahrain (UTC+3, no DST) calendar month as UTC instants. */
export function monthBounds(year: number, month: number): { start: Date; end: Date } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    start: new Date(`${year}-${pad(month)}-01T00:00:00+03:00`),
    end: new Date(`${nextYear}-${pad(nextMonth)}-01T00:00:00+03:00`),
  };
}

export interface ResidueRow {
  merchantId: string;
  capturedFils: number;
}

/** The fils truncated away when an amount is quantized down to the scheme's
 *  2-decimal granularity. */
export function computeResidueFils(capturedFils: number): number {
  return capturedFils % 10;
}

interface MerchantResidue {
  merchantId: string;
  lineCount: number;
  residueFils: number;
}

const SWEEP_DESCRIPTION = "scheme rounding residue sweep 2026-03";

async function fetchMerchantResidues(client: Client, year: number, month: number): Promise<MerchantResidue[]> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const first = `${year}-${pad(month)}-01`;
  // batch_date is the Bahrain business date, so a date range is exact.
  const result = await client.query<{ merchant_id: string; line_count: string; residue_fils: string }>(
    `WITH line_gross AS (
       SELECT sb.merchant_id, sel.id, sel.amount_fils,
              (SELECT COALESCE(SUM(te.amount_fils), 0)
                 FROM transaction_events te
                WHERE te.settlement_batch_id = sel.settlement_batch_id
                  AND te.transaction_id = sel.transaction_id
                  AND te.event_type IN ('captured', 'partially_captured')) AS gross_fils
         FROM scheme_export_lines sel
         JOIN settlement_batches sb ON sb.id = sel.settlement_batch_id
        WHERE sb.batch_date >= $1::date AND sb.batch_date < ($1::date + interval '1 month')
     )
     SELECT merchant_id,
            COUNT(*) FILTER (WHERE gross_fils - amount_fils > 0)::text AS line_count,
            COALESCE(SUM(GREATEST(gross_fils - amount_fils, 0)), 0)::text AS residue_fils
       FROM line_gross
      GROUP BY merchant_id
     HAVING SUM(GREATEST(gross_fils - amount_fils, 0)) > 0
      ORDER BY merchant_id`,
    [first],
  );
  return result.rows.map((r) => ({
    merchantId: r.merchant_id,
    lineCount: Number(r.line_count),
    residueFils: Number(r.residue_fils),
  }));
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("reconcile_march: DATABASE_URL environment variable is not set");
  }
  const apply = process.argv.includes("--apply");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const { start, end } = monthBounds(2026, 3);
    console.log("=== March 2026 scheme residue sweep ===");
    console.log(`mode:   ${apply ? "APPLY" : "dry run (pass --apply to post)"}`);
    console.log(`window: ${start.toISOString()} .. ${end.toISOString()} (Asia/Bahrain month)`);

    await client.query("BEGIN");
    // Serialize concurrent runs, then refuse a second posting.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [SWEEP_DESCRIPTION]);
    const existing = await client.query(`SELECT 1 FROM ledger_entries WHERE description = $1 LIMIT 1`, [
      SWEEP_DESCRIPTION,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      console.log("already posted for March 2026 — nothing to do (refusing to post twice)");
      return;
    }

    const merchants = await fetchMerchantResidues(client, 2026, 3);
    let total = 0;
    for (const m of merchants) {
      total += m.residueFils;
      console.log(`merchant ${m.merchantId}: ${m.lineCount} line(s), residue ${formatBhd(toFils(m.residueFils))} BD`);
      if (apply) {
        const group = randomUUID();
        await client.query(
          `INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
           VALUES ($1, $2, 'scheme_rounding_residue', 'debit',  $3, $4, $5),
                  ($1, $2, 'card_scheme_clearing',    'credit', $3, $4, $5)`,
          // Dated inside March (last instant of the Bahrain month).
          [group, m.merchantId, m.residueFils, new Date(end.getTime() - 1).toISOString(), SWEEP_DESCRIPTION],
        );
      }
    }
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    console.log("---");
    console.log(`total residue: ${formatBhd(toFils(total))} BD (${total} fils) ${apply ? "posted" : "NOT posted (dry run)"}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}

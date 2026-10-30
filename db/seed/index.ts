#!/usr/bin/env -S npx tsx
/**
 * CLI entry point: generate() the deterministic seed, then run every
 * self-verify assertion against it. Exits non-zero iff any REAL assertion
 * fails.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx db/seed/index.ts
 */
import { Pool } from "pg";
import { generate } from "./generate.js";
import { buildAssertions, runAssertions } from "./selfVerify.js";

/**
 * R9: generate() runs `TRUNCATE merchants, ... CASCADE`, which also empties
 * every table that references them — transactions, ledger, settlements,
 * refunds, real merchants' data. The compose comment claimed "the seed only
 * truncates its own fixture tables, so pointing this at a shared database
 * is fine". It is not. Refuse unless the database is empty, or holds only
 * seed merchants, or the operator names the database to wipe explicitly.
 */
async function assertSafeToReset(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ db: string; total: string; foreign: string }>(
    `SELECT current_database() AS db,
            (SELECT count(*) FROM merchant_users) AS total,
            (SELECT count(*) FROM merchant_users
              WHERE email NOT LIKE '%.example' AND email NOT LIKE '%.test') AS foreign`,
  );
  const { db, total, foreign } = rows[0]!;
  const confirmed = process.env.SEED_CONFIRM_WIPE === db;
  if (process.env.NODE_ENV === "production" && !confirmed) {
    throw new Error(`seed: NODE_ENV=production — refusing to TRUNCATE. Set SEED_CONFIRM_WIPE=${db} if you really mean it.`);
  }
  if (Number(foreign) > 0 && !confirmed) {
    throw new Error(
      `seed: database '${db}' has ${foreign} non-seed user(s) of ${total}; the seed would TRUNCATE ... CASCADE ` +
        `all of their data. Set SEED_CONFIRM_WIPE=${db} to proceed.`,
    );
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("seed: DATABASE_URL environment variable is not set");
  }

  // SEED_SIZE accepts small | full, but only 'small' is really implemented
  // so far — 'full' currently generates the same data.
  const seedSize = process.env.SEED_SIZE ?? "small";
  if (seedSize !== "small" && seedSize !== "full") {
    throw new Error(`seed: SEED_SIZE must be 'small' or 'full', got '${seedSize}'`);
  }

  // A Pool (not a bare Client): generate() needs its own checked-out client
  // for the main truncate+insert transaction, and needs the pool again
  // afterward for recordKycReview()/issueApiKey(), which open their own
  // transactions once that first one has committed and released.
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  try {
    await assertSafeToReset(pool);
    const summary = await generate(pool);
    console.log(
      `seed: generated ${summary.merchantCount} merchants, ${summary.merchantUserCount} merchant_users, ` +
        `${summary.transactionCount} transactions, ${summary.ledgerEntryCount} ledger_entries ` +
        `(${summary.ledgerGroupCount} groups), ${summary.holdCount} holds, ` +
        `${summary.settlementBatchCount} settlement_batches, ${summary.schemeExportLineCount} scheme_export_lines, ` +
        `${summary.outboxEventCount} outbox_events, ${summary.transactionEventCount} transaction_events, ` +
        `${summary.splitChildCount} merchant_split_children, ${summary.feeScheduleCount} fee_schedules, ` +
        `${summary.businessProfileCount} business_profiles, ` +
        `${summary.kycReviewCount} kyc_reviews, ${summary.apiKeyCount} api_keys, ` +
        `${summary.adminUserCount} admin_users`,
    );
    console.log(`seed: ledger_entries checksum = ${summary.ledgerChecksum}`);
    console.log("");

    const assertions = buildAssertions(pool, { initialLedgerChecksum: summary.ledgerChecksum });
    const allRealPassed = await runAssertions(assertions);

    if (!allRealPassed) {
      console.error("\nseed: one or more REAL assertions failed");
      process.exitCode = 1;
    } else {
      console.log("\nseed: all REAL assertions passed");
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

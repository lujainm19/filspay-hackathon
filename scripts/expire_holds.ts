#!/usr/bin/env -S npx tsx
/**
 * Nightly janitor: a hold that's never captured or released just sits in
 * the table past its expires_at forever — nothing else in the platform
 * ever deletes a holds row (authorize.ts inserts one, capture.ts/void.ts
 * release one; nothing sweeps one). Run once a night from cron/the host's
 * own scheduler.
 *
 * Usage: DATABASE_URL=postgres://... npx tsx scripts/expire_holds.ts
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { buildDelete } from "./lib/sqlFilter.js";

/** Holds that outlived their authorization window without being captured
 *  or released — the candidate set for tonight's cleanup. */
export async function fetchExpiredHoldIds(client: Client): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM holds WHERE status = 'active' AND expires_at < now()`,
  );
  return result.rows.map((r) => r.id);
}

/**
 * R3: the sweep is one atomic statement. It marks holds 'expired' (the
 * status the schema defines for exactly this) instead of deleting them, and
 * re-checks status/expiry in the same statement, so a hold captured or
 * released between "find" and "act" is never touched — the old
 * SELECT-then-DELETE could delete a hold that had just been captured, and
 * with nothing expired it deleted every row in the table.
 */
export const EXPIRE_HOLDS_SQL = `UPDATE holds SET status = 'expired'
  WHERE status = 'active' AND expires_at < now()
  RETURNING id`;

export async function expireHolds(client: Pick<Client, "query">): Promise<string[]> {
  const result = await client.query<{ id: string }>(EXPIRE_HOLDS_SQL);
  return result.rows.map((r) => r.id);
}

/** Legacy helper kept for its tests; no longer used by main(). */
export function buildExpiredHoldsDelete(expiredIds: string[]): { text: string; values: unknown[] } {
  return buildDelete("holds", { id: expiredIds });
}

/**
 * Expires only holds that are still 'active' and past expires_at. Captured
 * or released holds are never touched, and a night with nothing expired
 * changes no rows.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("expire_holds: DATABASE_URL environment variable is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const expiredIds = await expireHolds(client);
    console.log(`expire_holds: marked ${expiredIds.length} abandoned hold(s) expired`);
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

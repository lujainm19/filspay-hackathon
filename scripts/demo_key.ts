#!/usr/bin/env -S npx tsx
/**
 * Prints a merchant id + a fresh API key for the seeded "Alpha Retail Co"
 * merchant, for the smoke test and the load test on the hosted box.
 *
 *   docker compose -f ops/docker-compose.yml exec api npx tsx scripts/demo_key.ts
 *
 * The raw key is shown once and never stored (only its hash is).
 */
import { Pool } from "pg";
import { loadConfig } from "../apps/api/src/config.js";
import { issueApiKey } from "../apps/api/src/apiKeys/issue.js";

const name = process.argv[2] ?? "Alpha Retail Co";
const config = loadConfig(process.env);
const pool = new Pool({ connectionString: config.databaseUrl, max: 2 });
try {
  const r = await pool.query<{ merchant_id: string; user_id: string }>(
    `SELECT m.id AS merchant_id, mu.id AS user_id
       FROM merchants m JOIN merchant_users mu ON mu.merchant_id = m.id AND mu.role = 'owner'
      WHERE m.display_name = $1 ORDER BY mu.created_at LIMIT 1`,
    [name],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`no merchant named "${name}" — run the seed first`);
  const key = await issueApiKey(pool, config, { merchantId: row.merchant_id, createdBy: row.user_id, label: "demo/load test" });
  console.log(`MERCHANT_ID=${row.merchant_id}`);
  console.log(`API_KEY=${key.rawKey}`);
} finally {
  await pool.end();
}

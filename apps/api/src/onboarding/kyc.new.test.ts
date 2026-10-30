/**
 * New test for S17: a PDF-only KYC document must actually be a PDF, not just
 * be named like one. Needs DATABASE_URL.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { recordKycDocument } from "./kyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("kyc.new.test.ts requires DATABASE_URL");
const dir = mkdtempSync(join(tmpdir(), "kyc-new-test-"));
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  KYC_UPLOAD_DIR: dir,
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
test.after(async () => {
  await pool.end();
  await rm(dir, { recursive: true, force: true });
});

test("S17: a JPEG renamed CR-2026.pdf is rejected as a commercial registration", async () => {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`KYC ${randomUUID()}`],
  );
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [merchant.rows[0]!.id, `kyc-${randomUUID()}@example.test`],
  );
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  await assert.rejects(
    () =>
      recordKycDocument(pool, config, {
        merchantId: merchant.rows[0]!.id,
        documentType: "commercial_registration",
        fileName: "CR-2026.pdf",
        buffer: jpegBytes,
        uploadedBy: user.rows[0]!.id,
      }),
    /document_must_be_pdf|must be a PDF/,
  );
});

/**
 * OTP delivery on the hosted box: with no email/SMS provider, the operator can
 * opt in to having codes written to the server log (OTP_LOG_CODES=true). Off by
 * default in production, and the code is never put in the HTTP response.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { sendOtpCode } from "./notifier.js";
import { sendAdminOtpCode } from "../adminAuth/notifier.js";

const base = {
  DATABASE_URL: "postgres://x@localhost/x",
  NODE_ENV: "production",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
  SETTLEMENT_INTERNAL_TOKEN: "t",
  ACQUIRER_CALLBACK_SIGNING_SECRET: "s",
};

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  return { lines, logger: { info: (obj: Record<string, unknown>) => void lines.push(obj) } };
}

test("production: OTP codes are not logged unless OTP_LOG_CODES=true", () => {
  const off = loadConfig(base);
  assert.equal(off.otpLogCodes, false);
  const a = capture();
  sendOtpCode(a.logger, off, { merchantUserId: "u", email: "e" }, "123456");
  sendAdminOtpCode(a.logger, off, { adminUserId: "a", email: "e" }, "654321");
  assert.ok(a.lines.every((l) => !("code" in l)));

  const on = loadConfig({ ...base, OTP_LOG_CODES: "true" });
  assert.equal(on.otpLogCodes, true);
  // Logging codes never turns on returning them in the response.
  assert.equal(on.otpDevExpose, false);
  const b = capture();
  sendOtpCode(b.logger, on, { merchantUserId: "u", email: "e" }, "123456");
  sendAdminOtpCode(b.logger, on, { adminUserId: "a", email: "e" }, "654321");
  assert.deepEqual(
    b.lines.map((l) => l.code),
    ["123456", "654321"],
  );
});

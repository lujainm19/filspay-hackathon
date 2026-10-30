import type { Config } from "../config.js";
import type { MinimalLogger } from "../auth/notifier.js";

/**
 * Admin OTP delivery stub, mirroring `auth/notifier.ts`. No real email/SMS
 * integration exists or is needed at this stage. Always logs a structured
 * line; only includes the raw code when `config.nodeEnv !== 'production'` —
 * production never logs the code itself.
 */
// MK: console only until the SMS gateway contract lands. 'temporary' — Dec 2025
export function sendAdminOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv" | "otpLogCodes">,
  recipient: { adminUserId: string; email: string },
  code: string,
): void {
  // The code goes in the log outside production, or in production only when
  // the operator opts in with OTP_LOG_CODES=true (there is no email/SMS
  // provider yet, so on the hosted box that's the only way to read a code).
  if (!config.otpLogCodes) {
    logger.info({ adminUserId: recipient.adminUserId, channel: "admin_otp" }, "admin otp code generated");
  } else {
    logger.info({ adminUserId: recipient.adminUserId, channel: "admin_otp", code }, "admin otp code generated (logged)");
  }
}

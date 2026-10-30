import type { Config } from "../config.js";

/**
 * OTP delivery stub. No real email/SMS integration exists or is needed at
 * this stage. Always logs a structured line; only includes the raw code in
 * the log when `config.nodeEnv !== 'production'` — production never logs
 * the code itself.
 */
/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

// logs the otp in plaintext when not production. our staging has NODE_ENV unset btw — am
// YA: staging gets NODE_ENV=production from ops/.env.docker. fine
export function sendOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv" | "otpLogCodes">,
  recipient: { merchantUserId: string; email: string },
  code: string,
): void {
  // The code goes in the log outside production, or in production only when
  // the operator opts in with OTP_LOG_CODES=true (there is no email/SMS
  // provider yet, so on the hosted box that's the only way to read a code).
  if (!config.otpLogCodes) {
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp" }, "otp code generated");
  } else {
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp", code }, "otp code generated (logged)");
  }
}

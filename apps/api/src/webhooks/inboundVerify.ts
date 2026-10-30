import { createHmac } from "node:crypto";
import { timingSafeEqualHex } from "../lib/crypto.js";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason = "malformed_header" | "signature_mismatch" | "stale_timestamp";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

/**
 * Verifies the signature on an inbound acquirer callback.
 *
 * S11 fix (FP-240 "the incoming check has its own problems"). What was wrong,
 * and why it mattered:
 *  1. No header at all counted as valid unless a flag was on, and the flag was
 *     off by default — so anyone could post a fake fraud verdict. The config
 *     default is now "required" (config.ts).
 *  2. The timestamp in the header was never checked, so a real callback
 *     captured once could be replayed forever. Now it must be within 5 min.
 *  3. The comparison used Buffer.compare, which stops at the first different
 *     byte, so response timing leaked how much of a guess was right. Now it's
 *     crypto.timingSafeEqual.
 *  4. It signed JSON.stringify of the *parsed* body, which only matches the
 *     acquirer's bytes if both sides happen to serialise identically. The route
 *     now passes the raw body string, so we check exactly what was sent.
 *
 * `payload` is the raw request body string; an object is accepted for tests
 * and is serialised with JSON.stringify.
 */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  requireSignature = false,
  options: { toleranceSeconds?: number; now?: number } = {},
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature
      ? { valid: false, reason: "malformed_header" }
      : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  const signedBody = typeof payload === "string" ? payload : JSON.stringify(payload);
  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${signedBody}`).digest("hex");

  if (!timingSafeEqualHex(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "stale_timestamp" };
  }

  return { valid: true };
}

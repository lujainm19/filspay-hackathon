import { applyRateFils, toFils } from "@filspay/money";

/**
 * Estimated fee for a single capture whose event didn't record the fee it was
 * charged (only the reconciliation "pending" figure falls back to this).
 *
 * R10 fix: this used float rates (`bps / 10_000`) and Math.round, which breaks
 * the integer-fils rule (ADR-0001) and rounds .5 up instead of half-to-even,
 * so it could disagree with the ledger by a fil. Now it uses the same integer
 * maths and the same order as capture.ts (M9): the negotiated discount comes
 * off the amount, then MDR on the rest.
 */
export function estimateFeeFils(amountFils: number, mdrBps: number, discountBps: number): number {
  const amount = toFils(amountFils);
  const discounted = amount - applyRateFils(amount, discountBps);
  return applyRateFils(toFils(discounted), mdrBps);
}

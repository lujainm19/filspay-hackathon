import { useState } from "react";
import { parseBhdToFils } from "@filspay/money";
import { describeError, request } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundResponse {
  id: string;
  amountFils: number;
  feeReversedFils: number;
  transactionStatus: string;
  refundedTotalFils: number;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE = new Set(["captured", "partially_captured", "partially_refunded"]);

/**
 * Refund control (FP-212), wired to POST /v1/merchants/:id/refunds.
 *
 * Changes from the parked draft:
 *  - amount is entered in BD ("4.750"), like every other money field a
 *    merchant sees, instead of raw fils;
 *  - one Idempotency-Key per *refund attempt* (generated when the drawer
 *    opens, renewed only after a definitive answer), so a double-click or a
 *    network retry can never refund twice — the draft minted a key per click;
 *  - shown for partially_refunded too, so a second partial refund is possible;
 *  - the result (amount, fee given back) is confirmed on screen.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const merchantId = me?.merchant.id;
  // What's left to give back: captured minus what earlier refunds already
  // returned (the API checks the same thing; M14). Nothing left = no button.
  const refundableFils = txn.capturedFils - txn.refundedFils;
  if (!REFUNDABLE.has(txn.status) || refundableFils <= 0) return null;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId || submitting) return;

    let amountFils: number | undefined;
    const trimmed = amount.trim();
    if (trimmed !== "") {
      try {
        amountFils = parseBhdToFils(trimmed);
      } catch {
        setError("Enter the amount in BD, e.g. 4.750");
        return;
      }
      if (amountFils <= 0) {
        setError("The amount must be more than zero");
        return;
      }
    }
    const label = amountFils === undefined ? "everything still refundable" : bhd(amountFils);
    if (!window.confirm(`Refund ${label}? The money goes back to the cardholder and cannot be recalled.`)) return;

    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { transactionId: txn.id };
      if (amountFils !== undefined) body.amountFils = amountFils;
      if (reason.trim() !== "") body.reason = reason.trim();
      const res = await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });
      setDone(`Refunded ${bhd(res.amountFils)} (fee returned: ${bhd(res.feeReversedFils)}).`);
      setOpen(false);
      setAmount("");
      setReason("");
      setIdempotencyKey(crypto.randomUUID());
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {done ? <p className="dash-success" role="status">{done}</p> : null}
        {error ? <p className="dash-error" role="alert">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount (BD) — leave blank to refund everything still refundable
              <input
                type="text"
                inputMode="decimal"
                placeholder="e.g. 4.750"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label>
              Reason (optional)
              <input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <p className="dash-muted">
              Captured: {bhd(txn.capturedFils)} · Still refundable: {bhd(refundableFils)}
            </p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding…" : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="dash-button"
            onClick={() => {
              setDone(null);
              setError(null);
              setOpen(true);
            }}
          >
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}

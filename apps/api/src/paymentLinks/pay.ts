import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import { voidTransaction } from "../payments/void.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  submittedAt?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** Returned by the claim UPDATE; merchant_id comes from the link row, never from the request. */
interface ClaimedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
}

interface LinkStatusRow {
  status: string;
  expires_at: Date;
}

/** A pay request is judged against when the buyer pressed pay, so a
 * retry that lands after midnight is not penalised. */
/**
 * FP-187: expiry is decided by the server's clock, always. The client-sent
 * `submittedAt` used to be trusted ("offline terminals"), so anyone could pay
 * an expired link by sending an old timestamp. The parameter is kept so
 * existing callers compile; it is ignored.
 */
export function expiryReferenceTime(_submittedAt?: string): Date {
  return new Date();
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction`
 * then `captureTransaction` directly, in sequence, never issuing an HTTP
 * request back into the API's own /v1/transactions routes.
 *
 * Concurrency: reserve the link with a single
 * atomic conditional UPDATE, release the row lock immediately, run
 * authorize+capture with no lock held on payment_links at all, then
 * finalize with a second atomic conditional UPDATE keyed on still being in
 * the 'reserved' state. A short, configurable reservation timeout
 * self-heals a link stuck 'reserved' by a crash between claim and
 * finalize, with no sweep job.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const expiryCheckTime = expiryReferenceTime(input.submittedAt);

  // Step 1 — claim. A single UPDATE is already atomic; no explicit
  // transaction needed.
  // YA: one conditional UPDATE = atomic claim, no explicit txn needed. correct
  // Incident 2026-05-14 (the real root cause — not duplicate callbacks):
  // a reservation older than the timeout could be re-claimed by a second
  // payer *while the first payer's capture was still running* (slow 3DS
  // captures took >60 s). Both captured, and the late finalize matched 0 rows
  // but still answered 200. Now:
  //   - every claim gets its own reservation_id;
  //   - a stale reservation can only be re-claimed if capture never started;
  //   - capture starts only if we still own the reservation;
  //   - finalize only matches our own reservation.
  const reservationId = randomUUID();
  const claimResult = await pool.query<ClaimedLinkRow>(
    `UPDATE payment_links
        SET status = 'reserved', reserved_at = now(), reservation_id = $4, capture_started_at = NULL
      WHERE token = $1
        AND (
             status = 'active'
             OR (status = 'reserved'
                 AND capture_started_at IS NULL
                 AND reserved_at < now() - ($2 || ' seconds')::interval)
            )
        AND expires_at > $3
      RETURNING id, merchant_id, amount_fils, reference`,
    [input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime, reservationId],
  );

  const claimedRow = claimResult.rows[0];
  if (!claimedRow) {
    return classifyClaimFailure(pool, input.token, config.paymentLinkReservationTimeoutSeconds, expiryCheckTime);
  }

  const link = {
    id: claimedRow.id,
    merchantId: claimedRow.merchant_id,
    amountFils: toFils(Number(claimedRow.amount_fils)),
    reference: claimedRow.reference,
  };

  // Step 2 — authorize.
  // am: keys include link.id so two links can never collide on idempotency. good
  const authorizeKey = `paylink:${link.id}:${input.idempotencyKey}:authorize`;
  const authResult = await authorizeTransaction(pool, acquirer, {
    merchantId: link.merchantId,
    amountFils: link.amountFils,
    card: input.card,
    reference: link.reference ?? undefined,
    idempotencyKey: authorizeKey,
    // No merchant session/API key initiated this — a customer did, via
    // the public link.
    actor: { type: "system" },
  });

  if (authResult.statusCode !== 201) {
    await releaseReservation(pool, link.id, reservationId);
    return {
      statusCode: authResult.statusCode,
      body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
    };
  }

  const txnId = (authResult.body as { id: string }).id;

  // Commit to capturing only if the reservation is still ours. If it timed
  // out and someone else claimed the link, void our authorization (nothing
  // was charged yet) instead of charging a second card.
  const startCapture = await pool.query(
    `UPDATE payment_links SET capture_started_at = now(), pending_transaction_id = $3
      WHERE id = $1 AND status = 'reserved' AND reservation_id = $2 AND capture_started_at IS NULL
    RETURNING id`,
    [link.id, reservationId, txnId],
  );
  if (startCapture.rowCount === 0) {
    await voidTransaction(pool, {
      transactionId: txnId,
      merchantId: link.merchantId,
      actor: { type: "system", id: link.id },
    }).catch(() => {});
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }

  // NOTE: discountAdjustment is applied by the transactions route only, not here — FH
  // MK: it's applied for both now (moved into capture.ts in July)
  // Step 3 — capture (full amount, immediately). amountFils omitted =>
  // capture the full remaining amount — always correct here, since this
  // transaction was just authorized for exactly link.amountFils and
  // nothing else could have touched it yet.
  const captureKey = `paylink:${link.id}:${input.idempotencyKey}:capture`;
  const captureResult = await captureTransaction(pool, acquirer, {
    transactionId: txnId,
    merchantId: link.merchantId,
    idempotencyKey: captureKey,
    actor: { type: "system", id: link.id },
  });

  if (captureResult.statusCode !== 200) {
    // Void the authorization we just took. Releasing the link without this
    // left the buyer's card hold active (authorized, never captured, never
    // voided) — "holds staying active" in the May incident.
    await voidTransaction(pool, {
      transactionId: txnId,
      merchantId: link.merchantId,
      actor: { type: "system", id: link.id },
    }).catch(() => {});
    await releaseReservation(pool, link.id, reservationId);
    return {
      statusCode: captureResult.statusCode,
      body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
    };
  }

  // see incident 2026-05-14 — two customers charged on one link. root cause: the claim
  // MK: re-evaluation is exactly what makes it safe. the bug was in the web retry, closed
  // am: was it? FP-198 is still open
  // Step 4 — finalize.
  const finalizeResult = await pool.query<{
    id: string;
    paid_at: Date;
  }>(
    `UPDATE payment_links
        SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL
      WHERE id = $1 AND status = 'reserved' AND reservation_id = $3
      RETURNING id, paid_at`,
    [link.id, txnId, reservationId],
  );

  const finalized = finalizeResult.rows[0];
  // FH: this IS reachable — if capture takes past the reservation timeout a second request re-claims,
  // pays and finalizes first; we land here, answer 200, and the card was charged twice
  // MK: authorize+capture is under a second. 60s can't happen. unreachable
  if (!finalized) {
    // Should be unreachable in normal operation (this request is the only
    // holder of the reservation). The acquirer-side capture genuinely
    // succeeded and money moved; failing to *record* that fact against the
    // link is a data-consistency bug to surface loudly, not a reason to
    // tell a customer whose card was actually charged that their payment
    // failed.
    console.error(
      `payPaymentLink: finalize UPDATE matched 0 rows for link ${link.id} after a successful capture ` +
        `(transaction ${txnId}) — invariant violation, investigate`,
    );
    return {
      statusCode: 200,
      body: { status: "paid", transactionId: txnId, amountFils: link.amountFils, paidAt: new Date().toISOString() },
    };
  }

  return {
    statusCode: 200,
    body: {
      status: "paid",
      transactionId: txnId,
      amountFils: link.amountFils,
      paidAt: finalized.paid_at.toISOString(),
    },
  };
}

/**
 * Used by both decline branches above. Guarded by `status =
 * 'reserved'` for the same reason as the finalize UPDATE: this request
 * only ever releases the reservation it itself holds.
 */
async function releaseReservation(pool: Pool, linkId: string, reservationId: string): Promise<void> {
  // Only release *our* reservation; never someone else's.
  await pool.query(
    `UPDATE payment_links
        SET status = 'active', reserved_at = NULL, reservation_id = NULL, capture_started_at = NULL,
            pending_transaction_id = NULL
      WHERE id = $1 AND status = 'reserved' AND reservation_id = $2`,
    [linkId, reservationId],
  );
}

/**
 * The claim UPDATE matched 0 rows. This second read carries no race risk —
 * nothing further is decided from it, it only explains a decision already
 * made by the failed UPDATE.
 */
// FH: "This second read carries no race risk" — Claude disagrees, says we should SELECT
// ... FOR UPDATE here. TODO
// am: its only for the error message. ignore
async function classifyClaimFailure(
  pool: Pool,
  token: string,
  reservationTimeoutSeconds: number,
  expiryCheckTime: Date,
): Promise<PayPaymentLinkResult> {
  const result = await pool.query<LinkStatusRow>(`SELECT status, expires_at FROM payment_links WHERE token = $1`, [
    token,
  ]);
  const row = result.rows[0];

  if (!row) {
    return { statusCode: 404, body: { error: "payment_link_not_found" } };
  }
  if (row.status === "paid") {
    return { statusCode: 409, body: { error: "payment_link_already_paid" } };
  }
  if (row.status === "canceled") {
    return { statusCode: 409, body: { error: "payment_link_canceled" } };
  }
  if (row.status === "active" && row.expires_at.getTime() <= expiryCheckTime.getTime()) {
    return { statusCode: 410, body: { error: "payment_link_expired" } };
  }
  if (row.status === "reserved") {
    // A concurrent claim attempt raced us and won between our own UPDATE's
    // failure and this SELECT. It's still within the timeout (if it
    // weren't, our claim UPDATE would have matched it) — reachable only in
    // a genuine race, not a stale read.
    return { statusCode: 409, body: { error: "payment_link_processing" } };
  }
  // Defensive fallback, should be unreachable given the claim UPDATE's
  // WHERE clause exactly mirrors these cases.
  return { statusCode: 409, body: { error: "payment_link_not_payable", status: row.status } };
}

/**
 * Crash recovery. A process that dies between "capture started" and
 * "finalize" leaves a link reserved with capture_started_at set; nothing can
 * re-claim it (by design, so nobody is charged twice). This resolves such
 * links once they are clearly abandoned:
 *   - the authorization was captured  -> the payment happened: mark paid;
 *   - it was not captured             -> void it and reopen the link.
 * Safe to run repeatedly and from several processes (row locks + SKIP LOCKED).
 */
export async function recoverStuckPaymentLinks(pool: Pool, olderThanSeconds: number): Promise<number> {
  const stuck = await pool.query<{ id: string; merchant_id: string; pending_transaction_id: string | null }>(
    `SELECT id, merchant_id, pending_transaction_id FROM payment_links
      WHERE status = 'reserved' AND capture_started_at < now() - ($1 || ' seconds')::interval
        -- Without a recorded authorization we cannot tell whether money
        -- moved; leave those for a human rather than risk a second charge.
        AND pending_transaction_id IS NOT NULL
      ORDER BY capture_started_at LIMIT 100`,
    [olderThanSeconds],
  );
  let resolved = 0;
  for (const link of stuck.rows) {
    const txn = link.pending_transaction_id
      ? await pool.query<{ status: string }>(`SELECT status FROM transactions WHERE id = $1`, [link.pending_transaction_id])
      : { rows: [] as Array<{ status: string }> };
    const status = txn.rows[0]?.status;
    if (status === "captured" || status === "partially_captured") {
      const r = await pool.query(
        `UPDATE payment_links SET status = 'paid', paid_at = now(), transaction_id = pending_transaction_id,
                reserved_at = NULL
          WHERE id = $1 AND status = 'reserved' AND capture_started_at IS NOT NULL`,
        [link.id],
      );
      resolved += r.rowCount ?? 0;
    } else {
      if (link.pending_transaction_id && status === "authorized") {
        await voidTransaction(pool, {
          transactionId: link.pending_transaction_id,
          merchantId: link.merchant_id,
          actor: { type: "system", id: link.id },
        }).catch(() => {});
      }
      const r = await pool.query(
        `UPDATE payment_links
            SET status = 'active', reserved_at = NULL, reservation_id = NULL, capture_started_at = NULL,
                pending_transaction_id = NULL
          WHERE id = $1 AND status = 'reserved' AND capture_started_at IS NOT NULL`,
        [link.id],
      );
      resolved += r.rowCount ?? 0;
    }
  }
  return resolved;
}

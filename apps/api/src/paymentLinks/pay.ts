import type { Pool } from "pg";
import { toFils } from "@filspay/money";
import { authorizeTransaction } from "../payments/authorize.js";
import { captureTransaction } from "../payments/capture.js";
import type { AcquirerSimulator, SimulatedCardInput } from "../acquirer/types.js";

export interface PayPaymentLinkInput {
  token: string;
  card: SimulatedCardInput;
  idempotencyKey: string;
  /** Sent by the checkout page. Ignored on purpose — see expiryReferenceTime. */
  submittedAt?: string;
}

export interface PayPaymentLinkResult {
  statusCode: number;
  body: unknown;
}

/** The link row, read under a row lock. merchant_id and amount come from
 *  here, never from the request. */
interface LockedLinkRow {
  id: string;
  merchant_id: string;
  amount_fils: string | number;
  reference: string | null;
  status: string;
  expires_at: Date;
}

/**
 * The instant a payment link's expiry is judged against.
 *
 * S10 fix (FP-187): what was wrong — this returned the `submittedAt` time the
 * browser sent. Why — the idea was to be kind to "offline terminals", but the
 * checkout page simply sends the buyer's own clock, and nothing stops anyone
 * from sending a date from last week. What it broke — a link that showed
 * "expired" could still be paid by sending an old timestamp. Expiry is a
 * server decision, so we always use the server's clock now.
 */
export function expiryReferenceTime(_submittedAt?: string): Date {
  return new Date();
}

/** Postgres "lock_not_available": another request already holds this link. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Each pay attempt holds one connection for the link lock and borrows a second
 * one for authorize/capture. If every pool connection were taken by a lock
 * holder, they would all wait forever for their second one. So at most half
 * the pool may hold link locks at once; extra attempts wait here, in memory.
 */
const waiting: Array<() => void> = [];
let active = 0;
async function acquireSlot(pool: Pool): Promise<() => void> {
  const limit = Math.max(1, Math.floor((pool.options.max ?? 10) / 2));
  if (active < limit) {
    active += 1;
  } else {
    // Wait for a finishing payment to hand us its slot directly.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.shift();
    if (next) {
      next(); // the slot passes straight to the next waiter; `active` stays the same
    } else {
      active -= 1;
    }
  };
}

/**
 * `POST /v1/payment-links/:token/pay` business logic (public,
 * unauthenticated). Calls `authorizeTransaction` then `captureTransaction`
 * directly, never issuing an HTTP request back into the API's own routes.
 *
 * C1 fix (incident 2026-05-14): what was wrong — a pay attempt "reserved" the
 * link with an UPDATE, and a reservation older than 60 seconds could be taken
 * over by the next buyer. Why — the timeout was meant to heal crashed
 * requests, but it can't tell "crashed" from "slow": Delta's big-basket
 * captures with a 3DS step took over a minute. The second buyer re-reserved
 * the link and paid while the first capture was still running. The first
 * request's finalize then matched nothing, logged an "invariant violation"
 * and still answered 200. What it broke — two cardholders charged for one
 * single-use link (it wasn't duplicate callbacks: 16 of 17 transactions had
 * exactly one callback note).
 *
 * Now we take a row lock on the link (`FOR UPDATE NOWAIT`) and hold it for the
 * whole authorize + capture + finalize. A second buyer can't get the lock and
 * is told "processing" straight away, however slow the first payment is. If
 * the process crashes, Postgres drops the connection and the lock with it, so
 * there's no timeout left to race against.
 */
export async function payPaymentLink(
  pool: Pool,
  acquirer: AcquirerSimulator,
  _config: { paymentLinkReservationTimeoutSeconds: number },
  input: PayPaymentLinkInput,
): Promise<PayPaymentLinkResult> {
  const now = expiryReferenceTime(input.submittedAt);
  const releaseSlot = await acquireSlot(pool);
  let lockClient;
  try {
    lockClient = await pool.connect();
  } catch (err) {
    releaseSlot();
    throw err;
  }
  let finished = false;
  try {
    await lockClient.query("BEGIN");

    // Step 1 — lock the link, or find out right away that someone else has it.
    let row: LockedLinkRow | undefined;
    try {
      const locked = await lockClient.query<LockedLinkRow>(
        `SELECT id, merchant_id, amount_fils, reference, status, expires_at
           FROM payment_links
          WHERE token = $1
          FOR UPDATE NOWAIT`,
        [input.token],
      );
      row = locked.rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === LOCK_NOT_AVAILABLE) {
        return { statusCode: 409, body: { error: "payment_link_processing" } };
      }
      throw err;
    }

    if (!row) {
      return { statusCode: 404, body: { error: "payment_link_not_found" } };
    }
    if (row.status === "paid") {
      return { statusCode: 409, body: { error: "payment_link_already_paid" } };
    }
    if (row.status === "canceled") {
      return { statusCode: 409, body: { error: "payment_link_canceled" } };
    }
    if (row.expires_at.getTime() <= now.getTime()) {
      return { statusCode: 410, body: { error: "payment_link_expired" } };
    }
    // 'active', or a 'reserved' row left behind by the old timeout-based code:
    // we hold the lock, so nobody else is paying it right now.

    const link = {
      id: row.id,
      merchantId: row.merchant_id,
      amountFils: toFils(Number(row.amount_fils)),
      reference: row.reference,
    };

    // Step 2 — authorize. Keys include link.id so two links never share one.
    const authResult = await authorizeTransaction(pool, acquirer, {
      merchantId: link.merchantId,
      amountFils: link.amountFils,
      card: input.card,
      reference: link.reference ?? undefined,
      idempotencyKey: `paylink:${link.id}:${input.idempotencyKey}:authorize`,
      // No merchant session/API key initiated this — a customer did, via the public link.
      actor: { type: "system" },
    });
    if (authResult.statusCode !== 201) {
      // Rolling back releases the lock; the link stays 'active' for a retry.
      return {
        statusCode: authResult.statusCode,
        body: { stage: "authorize", ...(authResult.body as Record<string, unknown>) },
      };
    }
    const txnId = (authResult.body as { id: string }).id;

    // Step 3 — capture the full amount, still holding the link lock.
    const captureResult = await captureTransaction(pool, acquirer, {
      transactionId: txnId,
      merchantId: link.merchantId,
      idempotencyKey: `paylink:${link.id}:${input.idempotencyKey}:capture`,
      actor: { type: "system", id: link.id },
    });
    if (captureResult.statusCode !== 200) {
      return {
        statusCode: captureResult.statusCode,
        body: { stage: "capture", ...(captureResult.body as Record<string, unknown>) },
      };
    }

    // Step 4 — finalize on the same locked row, then commit (releases the lock).
    const finalized = await lockClient.query<{ paid_at: Date }>(
      `UPDATE payment_links
          SET status = 'paid', paid_at = now(), transaction_id = $2, reserved_at = NULL
        WHERE id = $1
        RETURNING paid_at`,
      [link.id, txnId],
    );
    await lockClient.query("COMMIT");
    finished = true;

    return {
      statusCode: 200,
      body: {
        status: "paid",
        transactionId: txnId,
        amountFils: link.amountFils,
        paidAt: finalized.rows[0]!.paid_at.toISOString(),
      },
    };
  } finally {
    if (!finished) {
      await lockClient.query("ROLLBACK").catch(() => {});
    }
    lockClient.release();
    releaseSlot();
  }
}

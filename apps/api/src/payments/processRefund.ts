import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerRefundResult, AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

export interface ProcessRefundInput {
  transactionId: string;
  /** The caller's own merchant. Only that merchant's transactions can be refunded. */
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/**
 * The MDR this transaction was really charged, net of any negotiated discount
 * that was given back at capture. Read from the ledger, so a later rate change
 * can't change what a refund reverses.
 *
 * Part of the M15 fix: the old code summed only the fee *credits*, ignoring the
 * "negotiated discount adjustment" debits, so a discounted merchant got back
 * more fee on a refund than they had actually paid.
 */
async function netFeeChargedFils(client: PoolClient, transactionId: string): Promise<Fils> {
  const result = await client.query<{ fee_fils: string }>(
    `SELECT COALESCE(SUM(CASE
              WHEN direction = 'credit' AND description = 'capture: MDR fee' THEN amount_fils
              WHEN direction = 'debit'  AND description = 'capture: negotiated discount adjustment' THEN -amount_fils
              ELSE 0 END), 0)::text AS fee_fils
       FROM ledger_entries
      WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [transactionId],
  );
  return toFils(Math.max(0, Number(result.rows[0]?.fee_fils ?? 0)));
}

/**
 * Refund business logic, in three steps (team decision "option B" for C2):
 *
 *   1. reserve — one short DB transaction: claim the idempotency key, lock the
 *      transaction row, validate, and write the refund as 'pending'. Commit.
 *   2. call the acquirer — with NO database lock or connection held.
 *   3. settle — one short DB transaction: lock the row again, mark the refund
 *      succeeded and journal it (or, on a decline/error, delete the
 *      reservation so the amount is refundable again).
 *
 * C2 fix (FP-209): what was wrong — the old version (1) read `refunded_fils`
 * *without a lock* and validated, (2) called the acquirer, (3) wrote
 * `refunded_fils = <the value read in step 1> + this refund`. Why it broke —
 * two refunds with different idempotency keys both read the same
 * `refunded_fils`, both passed validation, both got money back from the
 * acquirer, and the second write simply overwrote the first. What it broke —
 * money paid out twice, and a `refunded_fils` that hid it. Now the second
 * refund's validation sees the first one's pending reservation, because both
 * run under the same row lock and the refundable amount is
 * captured − refunded − pending.
 *
 * Why not just hold the row lock across the acquirer call (what capture does,
 * and the first version of this fix)? It is just as safe, but every refund
 * then keeps a pool connection busy for the whole network call; with a slow
 * acquirer that starves checkout. Here the lock is held for milliseconds.
 *
 * M14 fix: the refundable amount is captured − already refunded (it was
 * authorized − refunded, so authorize 10 BD, capture 4, refund 10 went through).
 *
 * M15 fix: the fee reversal is worked out on the running total. The old code
 * rounded each partial refund's share on its own, so two half refunds of a
 * 3-fil fee came back as 2 + 2 = 4 fils — more than was ever charged. Now each
 * refund reverses "the fee share for everything refunded so far, minus what
 * earlier refunds already reversed", so the reversals always add up to at most
 * the fee, and exactly the fee on a full refund.
 */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  const reservation = await reserveRefund(pool, input, requestHash);
  if (reservation.kind === "answered") return reservation.result;

  const acquirerResult = await callAcquirer(acquirer, reservation);
  return settleRefund(pool, reservation.refundId, acquirerResult);
}

interface PendingRefund {
  kind: "reserved";
  refundId: string;
  amountFils: Fils;
  transactionAcquirerReference: string;
  acquirerIdempotencyKey: string;
}

type Reservation = PendingRefund | { kind: "answered"; result: ProcessRefundResult };

/** Step 1: claim the key, lock, validate, write the pending row. */
async function reserveRefund(pool: Pool, input: ProcessRefundInput, requestHash: string): Promise<Reservation> {
  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });
    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return { kind: "answered", result: { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody } };
    }

    // Lock before validating, scoped to the caller's merchant (S8).
    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { kind: "answered", result: { statusCode: 404, body } };
    }

    // Money another refund has reserved but not finished yet is not refundable.
    const pending = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_fils), 0)::text AS total
         FROM refunds WHERE transaction_id = $1 AND status = 'pending'`,
      [txn.id],
    );
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));
    const pendingFils = toFils(Number(pending.rows[0]?.total ?? 0));
    // M14: captured, not authorized. C2: minus what's already reserved.
    const refundableFils = toFils(Math.max(0, subtractFils(subtractFils(capturedFils, refundedFils), pendingFils)));

    const validation = validateRefundRequest(
      { id: txn.id, merchantId: txn.merchant_id, status: txn.status, capturedFils, refundableFils },
      input.amountFils,
    );
    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { kind: "answered", result: { statusCode, body: validation } };
    }

    // The key we send the acquirer, stored so a recovery pass can ask again
    // with the same key and get the same answer (the acquirer dedupes on it).
    const acquirerIdempotencyKey = `${claim.row.id}:${claim.row.attemptCount}`;
    const reserved = await client.query<{ id: string }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference,
          reason, created_by_type, created_by_id, idempotency_key_id, acquirer_idempotency_key)
       VALUES ($1, $2, $3, 0, 'pending', NULL, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        txn.id,
        txn.merchant_id,
        validation.amountFils,
        // B6: 0070 made reason NOT NULL (default 'unspecified'); passing an explicit
        // NULL bypassed the default and failed the CHECK, so every refund without a
        // reason errored.
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
        claim.row.id,
        acquirerIdempotencyKey,
      ],
    );
    return {
      kind: "reserved",
      refundId: reserved.rows[0]!.id,
      amountFils: validation.amountFils,
      transactionAcquirerReference: txn.acquirer_reference,
      acquirerIdempotencyKey,
    };
  });
}

/** Step 2: the network call. No DB connection is held here. */
async function callAcquirer(acquirer: AcquirerSimulator, refund: PendingRefund): Promise<AcquirerRefundResult> {
  try {
    return await acquirer.refund({
      acquirerReference: refund.transactionAcquirerReference,
      amountFils: refund.amountFils,
      idempotencyKey: refund.acquirerIdempotencyKey,
    });
  } catch {
    // A thrown call is a transport failure: nothing we can confirm happened.
    return { outcome: "error", acquirerReference: "", latencyMs: 0 };
  }
}

interface PendingRefundRow {
  id: string;
  transaction_id: string;
  amount_fils: string | number;
  status: string;
  idempotency_key_id: string | null;
  created_by_type: "merchant_session" | "merchant_api_key";
  created_by_id: string;
}

/**
 * Step 3: turn the pending row into a real refund, or release it.
 * Also used by recoverStuckRefunds, so it must cope with the row having been
 * settled already by someone else (then it returns the stored answer).
 */
async function settleRefund(
  pool: Pool,
  refundId: string,
  acquirerResult: AcquirerRefundResult,
): Promise<ProcessRefundResult> {
  return withTransaction(pool, async (client) => {
    // Same lock order as step 1: the transaction row first, then the refund.
    const peek = await client.query<{ transaction_id: string }>(`SELECT transaction_id FROM refunds WHERE id = $1`, [
      refundId,
    ]);
    const transactionId = peek.rows[0]?.transaction_id;
    const txnResult = transactionId
      ? await client.query<RefundTransactionRow>(
          `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
             FROM transactions WHERE id = $1 FOR UPDATE`,
          [transactionId],
        )
      : { rows: [] as RefundTransactionRow[] };
    const refundResult = await client.query<PendingRefundRow>(
      `SELECT id, transaction_id, amount_fils, status, idempotency_key_id, created_by_type, created_by_id
         FROM refunds WHERE id = $1 FOR UPDATE`,
      [refundId],
    );
    const pending = refundResult.rows[0];
    const txn = txnResult.rows[0];
    if (!pending || pending.status !== "pending" || !txn) {
      return storedAnswer(client, pending?.idempotency_key_id ?? null);
    }
    const claimId = pending.idempotency_key_id;
    const requestedAmount = toFils(Number(pending.amount_fils));

    if (acquirerResult.outcome !== "approved") {
      // Release the reservation: nothing was refunded, so no row stays behind.
      await client.query(`DELETE FROM refunds WHERE id = $1`, [refundId]);
      if (acquirerResult.outcome === "declined") {
        const body = { error: "refund_declined" };
        if (claimId) await completeIdempotencyKey(client, claimId, { statusCode: 402, body });
        return { statusCode: 402, body };
      }
      const body = { error: "acquirer_unavailable" };
      if (claimId) await failIdempotencyKey(client, claimId, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    // Fresh numbers, read under the lock (another refund may have settled
    // while we were at the acquirer).
    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));
    const newRefundedTotal = addFils(refundedFils, requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: amountAuthorized,
      capturedFils,
      refundedTotalFils: newRefundedTotal,
    });

    // M15: cumulative fee reversal (see the comment above processRefund).
    const feeChargedFils = await netFeeChargedFils(client, txn.id);
    const alreadyReversed = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(fee_reversed_fils), 0)::text AS total
         FROM refunds WHERE transaction_id = $1 AND status = 'succeeded'`,
      [txn.id],
    );
    const alreadyReversedFils = toFils(Number(alreadyReversed.rows[0]?.total ?? 0));
    const shareSoFar = calculateRefundFee(capturedFils, feeChargedFils, newRefundedTotal);
    const feeReversedFils = toFils(Math.max(0, shareSoFar - alreadyReversedFils));

    // occurred_at = when the money actually went back (settlement windows use it).
    const settled = await client.query<{ occurred_at: Date }>(
      `UPDATE refunds
          SET status = 'succeeded', acquirer_reference = $2, fee_reversed_fils = $3, occurred_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING occurred_at`,
      [refundId, acquirerResult.acquirerReference, feeReversedFils],
    );
    const occurredAt = settled.rows[0]!.occurred_at;

    // Add to the total in SQL rather than writing back a value computed from
    // an earlier read. 0074's CHECK stops it ever passing captured_fils.
    await client.query(`UPDATE transactions SET refunded_fils = refunded_fils + $2, status = $3 WHERE id = $1`, [
      txn.id,
      requestedAmount,
      newStatus,
    ]);

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, txn.merchant_id, txn.id, requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, txn.merchant_id, txn.id, feeReversedFils],
      );
    }

    const actor = { type: pending.created_by_type, id: pending.created_by_id };
    // The timeline shows what this refund did to the captured amount.
    const eventType = compareFils(newRefundedTotal, capturedFils) >= 0 ? "refunded" : "refund_partial";
    await recordTransactionEvent(client, {
      transactionId: txn.id,
      eventType,
      amountFils: toFils(-requestedAmount, { allowNegative: true }),
      actor,
      metadata: { refundId, feeReversedFils, acquirerReference: acquirerResult.acquirerReference },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: txn.id,
      payload: {
        merchantId: txn.merchant_id,
        refundId,
        amountFils: requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refundId,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountFils: requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: occurredAt.toISOString(),
    };
    if (claimId) await completeIdempotencyKey(client, claimId, { statusCode: 200, body, resourceId: refundId });
    return { statusCode: 200, body };
  });
}

/** The answer already recorded for a refund someone else settled. */
async function storedAnswer(client: PoolClient, claimId: string | null): Promise<ProcessRefundResult> {
  if (claimId) {
    const row = await client.query<{ response_status_code: number | null; response_body: unknown }>(
      `SELECT response_status_code, response_body FROM idempotency_keys WHERE id = $1`,
      [claimId],
    );
    const stored = row.rows[0];
    if (stored?.response_status_code) return { statusCode: stored.response_status_code, body: stored.response_body };
  }
  throw new ConflictError("request_in_progress");
}

/**
 * Crash recovery for step 2. If the API dies after reserving but before
 * settling, the refund stays 'pending': the money is held back (safe — it
 * can't be refunded twice) and the idempotency key stays in_progress, so the
 * merchant's retries get a 409. This finds pending refunds older than
 * `olderThanSeconds`, asks the acquirer again *with the same idempotency key*
 * (a real acquirer returns the original answer instead of refunding again),
 * and settles them. Runs from index.ts next to the payment-link recovery.
 */
export async function recoverStuckRefunds(
  pool: Pool,
  acquirer: AcquirerSimulator,
  olderThanSeconds: number,
): Promise<number> {
  const stuck = await pool.query<{
    id: string;
    amount_fils: string | number;
    acquirer_idempotency_key: string | null;
    txn_acquirer_reference: string;
  }>(
    `SELECT r.id, r.amount_fils, r.acquirer_idempotency_key, t.acquirer_reference AS txn_acquirer_reference
       FROM refunds r
       JOIN transactions t ON t.id = r.transaction_id
      WHERE r.status = 'pending' AND r.created_at < now() - ($1 || ' seconds')::interval
        -- Without the key we sent we can't safely ask again; leave it for a human.
        AND r.acquirer_idempotency_key IS NOT NULL
      ORDER BY r.created_at
      LIMIT 100`,
    [olderThanSeconds],
  );
  let settled = 0;
  for (const row of stuck.rows) {
    const result = await callAcquirer(acquirer, {
      kind: "reserved",
      refundId: row.id,
      amountFils: toFils(Number(row.amount_fils)),
      transactionAcquirerReference: row.txn_acquirer_reference,
      acquirerIdempotencyKey: row.acquirer_idempotency_key!,
    });
    await settleRefund(pool, row.id, result).catch(() => undefined);
    settled += 1;
  }
  return settled;
}

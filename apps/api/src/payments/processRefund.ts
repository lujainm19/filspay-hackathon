import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
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
 * Refund business logic: lock the transaction, validate, call the acquirer,
 * then journal the reversal — all in ONE database transaction, exactly like
 * capture.ts.
 *
 * C2 fix (FP-209): what was wrong — the old version ran in two separate
 * transactions: (1) read `refunded_fils` *without a lock*, validate and commit,
 * (2) call the acquirer, (3) open a new transaction and write
 * `refunded_fils = <the value read in step 1> + this refund`. Why it broke —
 * two refunds with different idempotency keys both read the same
 * `refunded_fils`, both passed validation, both got money back from the
 * acquirer, and the second write simply overwrote the first. What it broke —
 * money paid out twice, and a `refunded_fils` that hid it. Payments never had
 * this because capture holds a `FOR UPDATE` row lock across the acquirer call.
 * Refunds now do the same: a second refund waits for the first to finish, then
 * re-validates against the real, updated total.
 *
 * M14 fix: the refundable amount is now captured − already refunded (it was
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
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }

    // Lock first, before validating, and keep the lock through the acquirer
    // call and the ledger writes. Scoped to the caller's merchant (S8).
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
      return { statusCode: 404, body };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));
    const refundableFils = subtractFils(capturedFils, refundedFils); // M14: captured, not authorized

    const validation = validateRefundRequest(
      { id: txn.id, merchantId: txn.merchant_id, status: txn.status, capturedFils, refundableFils },
      input.amountFils,
    );
    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { statusCode, body: validation };
    }
    const requestedAmount = validation.amountFils;

    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: requestedAmount,
      idempotencyKey: `${claim.row.id}:${claim.row.attemptCount}`,
    });
    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, claim.row.id, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

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

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        txn.id,
        txn.merchant_id,
        requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        // B6: 0070 made reason NOT NULL (default 'unspecified'); passing an explicit
        // NULL bypassed the default and failed the CHECK, so every refund without a
        // reason errored.
        input.reason ?? "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    // Add to the total in SQL rather than writing back a value computed from
    // an earlier read — belt and braces on top of the row lock.
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

    // The timeline shows what this refund did to the captured amount.
    const eventType = compareFils(newRefundedTotal, capturedFils) >= 0 ? "refunded" : "refund_partial";
    await recordTransactionEvent(client, {
      transactionId: txn.id,
      eventType,
      amountFils: toFils(-requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: { refundId: refund.id, feeReversedFils, acquirerReference: acquirerResult.acquirerReference },
    });

    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: txn.id,
      payload: {
        merchantId: txn.merchant_id,
        refundId: refund.id,
        amountFils: requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountFils: requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, claim.row.id, { statusCode: 200, body, resourceId: refund.id });
    return { statusCode: 200, body };
  });
}

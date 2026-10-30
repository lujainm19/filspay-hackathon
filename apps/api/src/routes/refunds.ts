import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils, type Fils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError } from "../lib/errors.js";

interface MerchantIdParams {
  merchantId: string;
}

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

const MAX_REASON_LENGTH = 500;

/** Same rule as authorize and capture: the client must send an Idempotency-Key. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * FP-300 (refunds, previously FP-212): `POST /v1/merchants/:merchantId/refunds`.
 *
 * What was missing: the only refund route was a stub at `/v1/refunds` that
 * answered 501, even though the dashboard's refund drawer already posts here.
 * Why it's built this way:
 *  - owner or finance only, never support and never an admin viewing as the
 *    merchant (refunds move money out);
 *  - the merchant comes from the login, and the path must match it (S8);
 *  - an Idempotency-Key header is required, so a retried click can't refund
 *    twice, and processRefund locks the transaction so two *different* clicks
 *    can't either (C2);
 *  - leave amountFils out to refund everything that's still refundable.
 *
 * Body: { transactionId, amountFils?, reason? } — amounts are integer fils.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      assertRefundRequestScope(auth, request.params.merchantId);
      const actor = requireMerchantWriterActor(auth); // refuses impersonation
      const idempotencyKey = getIdempotencyKey(request);

      const { transactionId, amountFils, reason } = request.body ?? {};
      if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
        throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
      }
      let amount: Fils | undefined;
      if (amountFils !== undefined && amountFils !== null) {
        if (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0) {
          throw new BadRequestError("invalid_amount", "amountFils must be a positive integer number of fils");
        }
        amount = toFils(amountFils);
      }
      if (reason !== undefined && reason !== null && (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH)) {
        throw new BadRequestError("invalid_reason", `reason must be text of at most ${MAX_REASON_LENGTH} characters`);
      }

      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: request.params.merchantId,
        transactionId,
        amountFils: amount,
        idempotencyKey,
        actor,
        reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : undefined,
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}

import type { FastifyInstance, FastifyRequest } from "fastify";
import { BadRequestError, UnauthorizedError } from "../lib/errors.js";
import { verifyAcquirerCallbackSignature } from "../webhooks/inboundVerify.js";
import { applyAcquirerCallback, withCallbackRetry, type AcquirerCallbackInput } from "../acquirer/callbacks.js";

// header name confirmed with the acquirer's integration guide v3.2 — am
const ACQUIRER_SIGNATURE_HEADER = "acquirer-callback-signature";

/**
 * Body of a fraud_review.completed callback. `outcome` is validated against
 * the AcquirerCallbackInput union ("approved" | "rejected") before it is
 * applied; any other value is a 400.
 */
interface AcquirerCallbackBody {
  callbackId?: string;
  type?: string;
  transactionId?: string;
  occurredAt?: string;
  outcome?: string;
  note?: string;
}

/** Header format: "t=<unix seconds>,v1=<hex hmac>". A repeated header uses the first value. */
function getSignatureHeader(request: FastifyRequest): string | undefined {
  const header = request.headers[ACQUIRER_SIGNATURE_HEADER];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * The acquirer's own async callback surface: the
 * acquirer simulator's authorize/capture/refund calls
 * (acquirer/simulator.ts) stay fully synchronous request/response, but a
 * delayed fraud-review verdict only ever resolves out of band, so the
 * acquirer posts the result back to us instead. Public — the caller is the
 * acquirer, not a FilsPay merchant session or admin user, so this route
 * carries no requireMerchantAuth/requireAdminSession preHandler.
 * Acquirer-Callback-Signature verification is the only authentication this
 * endpoint has.
 */
export async function acquirerCallbackRoutes(app: FastifyInstance): Promise<void> {
  // S11: keep the exact bytes the acquirer sent so the signature is checked
  // over them, not over our own re-serialisation of the parsed JSON. This
  // parser only applies inside this plugin (Fastify scopes it), so other
  // routes are untouched.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    (request as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  app.post<{ Body: AcquirerCallbackBody }>("/callbacks", async (request, reply) => {
    const body = request.body ?? {};
    if (
      !body.callbackId ||
      body.type !== "fraud_review.completed" ||
      !body.transactionId ||
      !body.occurredAt ||
      !body.outcome ||
      !body.note
    ) {
      throw new BadRequestError(
        "invalid_request",
        "callbackId, type, transactionId, occurredAt, outcome, and note are required",
      );
    }

    const verification = verifyAcquirerCallbackSignature(
      (request as FastifyRequest & { rawBody?: string }).rawBody ?? body,
      getSignatureHeader(request),
      app.config.acquirerCallbackSigningSecret,
      app.config.acquirerCallbackRequireSignature,
    );
    if (!verification.valid) {
      throw new UnauthorizedError("invalid_signature", verification.reason);
    }

    // The docs say outcome is checked against the allowed values; it wasn't —
    // any string was cast straight through. Check it after the signature.
    if (body.outcome !== "cleared" && body.outcome !== "confirmed_fraud") {
      throw new BadRequestError("invalid_request", "outcome must be cleared or confirmed_fraud");
    }

    const callback: AcquirerCallbackInput = {
      callbackId: body.callbackId,
      type: "fraud_review.completed",
      transactionId: body.transactionId,
      occurredAt: body.occurredAt,
      outcome: body.outcome as AcquirerCallbackInput["outcome"],
      note: body.note,
    };

    await withCallbackRetry(() => applyAcquirerCallback(app.db, callback));
    reply.code(200).send({ received: true });
  });
}

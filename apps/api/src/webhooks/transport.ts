import { lookup } from "node:dns/promises";
import { isLocalHostname, isPrivateAddress } from "./ssrf.js";

/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** We keep only a short excerpt of a receiver's reply (2,000 chars are stored). */
const MAX_RESPONSE_BYTES = 4_096;

/**
 * Real transport: Node's global fetch with an AbortController-driven timeout,
 * used by index.ts's production wiring.
 *
 * `blockPrivateNetworks` (on in production) — S18: before sending, resolve the
 * hostname and refuse if it lands on a private, loopback or link-local address.
 * create.ts already blocks such URLs when they're typed in, but a public-looking
 * name can still resolve to an internal IP, so we check what it resolves to now.
 */
export function createFetchTransport(options: { blockPrivateNetworks?: boolean } = {}): WebhookTransport {
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      if (options.blockPrivateNetworks) {
        const { hostname } = new URL(req.url);
        const addresses = isPrivateAddress(hostname)
          ? [{ address: hostname }]
          : await lookup(hostname, { all: true });
        if (isLocalHostname(hostname) || addresses.some((a) => isPrivateAddress(a.address))) {
          return { statusCode: null, body: "", errorMessage: "refused: webhook host resolves to a private address" };
        }
      }
      // S18: don't follow redirects. A public receiver could otherwise answer
      // "302 → http://169.254.169.254/..." and fetch would follow it from
      // inside our network. A redirect is just a non-2xx reply, so it's retried
      // and eventually marked exhausted like any other failure.
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        redirect: "manual",
      });
      // W4 fix: what was wrong — `await response.text()` read the whole reply
      // with no size limit. Why it matters — we only keep 2,000 characters, but
      // a receiver (or attacker) answering with hundreds of MB inside the
      // timeout would have it all buffered in our 512 MB process. What it broke
      // — one endpoint could OOM the API. Now we read at most 4 KB and stop.
      const body = await readCapped(response, MAX_RESPONSE_BYTES);
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

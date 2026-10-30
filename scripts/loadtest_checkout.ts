/**
 * Checkout capacity test: each virtual user repeatedly
 *   1. creates a payment link (merchant API key),
 *   2. loads it as the buyer (GET /v1/payment-links/:token),
 *   3. pays it (POST /v1/payment-links/:token/pay).
 * Reports completed checkouts/s, latency percentiles and error mix per stage.
 *
 *   BASE_URL=http://localhost:3100 API_KEY=fp_test_... \
 *   npx tsx scripts/loadtest_checkout.ts 10 20 40 80
 */
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const KEY = process.env.API_KEY ?? "";
const MERCHANT = process.env.MERCHANT_ID ?? "";
const DURATION_MS = Number(process.env.DURATION_MS ?? 20_000);
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function checkout(): Promise<{ ok: boolean; ms: number; status: number }> {
  const t0 = performance.now();
  const link = await call(
    "POST",
    `/v1/merchants/${MERCHANT}/payment-links`,
    { amountFils: 4_750, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reference: "load" },
    { authorization: `Bearer ${KEY}` },
  );
  if (link.status !== 201) return { ok: false, ms: performance.now() - t0, status: link.status };
  const token = link.json.token as string;
  const view = await call("GET", `/v1/payment-links/${token}`);
  if (view.status !== 200) return { ok: false, ms: performance.now() - t0, status: view.status };
  const pay = await call("POST", `/v1/payment-links/${token}/pay`, { card: CARD }, { "idempotency-key": randomUUID() });
  return { ok: pay.status === 200, ms: performance.now() - t0, status: pay.status };
}

function pct(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function run(vus: number) {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let ok = 0;
  const end = Date.now() + DURATION_MS;
  await Promise.all(
    Array.from({ length: vus }, async () => {
      while (Date.now() < end) {
        try {
          const r = await checkout();
          statuses[r.status] = (statuses[r.status] ?? 0) + 1;
          if (r.ok) {
            ok += 1;
            latencies.push(r.ms);
          }
        } catch {
          statuses.network = (statuses.network ?? 0) + 1;
        }
      }
    }),
  );
  latencies.sort((a, b) => a - b);
  console.log(
    `vus=${vus} checkouts/s=${(ok / (DURATION_MS / 1000)).toFixed(1)} p50=${pct(latencies, 50).toFixed(0)}ms ` +
      `p95=${pct(latencies, 95).toFixed(0)}ms p99=${pct(latencies, 99).toFixed(0)}ms statuses=${JSON.stringify(statuses)}`,
  );
}

for (const v of process.argv.slice(2).map(Number)) {
  await run(v);
}

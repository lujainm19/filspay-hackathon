/**
 * End-to-end smoke test of a running stack, over HTTP like real clients:
 * merchant login + OTP, API keys, checkout (incl. two buyers at once),
 * FP-187 expiry, cross-merchant access, capture, partial + concurrent
 * refunds and their ledger / fee / timeline / outbox effects,
 * reconciliation, CSV export, SSRF, signed / unsigned / replayed acquirer
 * callbacks, and the admin console's balance rebuild.
 *
 * Needs the seeded demo data (`npm run seed`), OTP_LOG_CODES=true on the API
 * (codes are read from its log), and read access to the database to check
 * the money.
 *
 *   BASE_URL=http://localhost:3000 API_LOG=/path/to/api.log \
 *   DATABASE_URL=postgres://... ACQUIRER_CALLBACK_SIGNING_SECRET=... \
 *   npx tsx scripts/e2e_smoke.ts
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const LOG = process.env.API_LOG ?? "api.log";
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const ACQ_SECRET = process.env.ACQUIRER_CALLBACK_SIGNING_SECRET ?? "";
const PASSWORD = "FilsPaySeed!2026";
const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  -> ${detail}`}`);
}

async function http(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined || opts.raw !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    redirect: "manual",
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* csv etc */
  }
  return { status: res.status, json, text, headers: res.headers };
}

function cookieOf(res: { headers: Headers }, name: string): string {
  const all = res.headers.getSetCookie();
  const c = all.find((x) => x.startsWith(name + "="));
  return c ? c.split(";")[0]! : "";
}

async function lastOtp(): Promise<string> {
  await new Promise((r) => setTimeout(r, 300));
  const lines = readFileSync(LOG, "utf8").trim().split("\n").reverse();
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j.code) return String(j.code);
    } catch {
      /* not json */
    }
  }
  throw new Error("no otp in log");
}

async function merchantLogin(merchantId: string, email: string) {
  const login = await http("POST", "/v1/auth/login", { body: { merchantId, email, password: PASSWORD } });
  const pending = cookieOf(login, "fp_sid");
  const code = await lastOtp();
  const verify = await http("POST", "/v1/auth/otp/verify", { body: { code }, headers: { cookie: pending } });
  return { login, pending, verify, cookie: cookieOf(verify, "fp_sid") };
}

const one = async <T,>(sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0] as T;

// ------------------------------------------------------------------ setup
const alpha = await one<{ id: string }>(`SELECT id FROM merchants WHERE display_name = 'Alpha Retail Co'`);
const beta = await one<{ id: string }>(`SELECT id FROM merchants WHERE display_name = 'Beta Digital Services'`);

// ------------------------------------------------------------------ auth
{
  const login = await http("POST", "/v1/auth/login", {
    body: { merchantId: alpha.id, email: "owner@alpharetail.example", password: PASSWORD },
  });
  check("login: password step answers 200 and asks for OTP", login.status === 200, login.text);
  check("S5: production login response does not contain the OTP", !login.text.includes("devOtpCode"), login.text);
  const pending = cookieOf(login, "fp_sid");
  const me = await http("GET", "/v1/auth/me", { headers: { cookie: pending } });
  const tx = await http("GET", "/v1/transactions", { headers: { cookie: pending } });
  check("S1: password-only cookie can't read transactions", tx.status === 401, `${tx.status}`);
  void me;
  const bad = await http("POST", "/v1/auth/otp/verify", { body: { code: "000000" }, headers: { cookie: pending } });
  check("OTP: wrong code is refused", bad.status === 401, `${bad.status}`);
}
const owner = await merchantLogin(alpha.id, "owner@alpharetail.example");
check("login: OTP verify succeeds", owner.verify.status === 200, owner.verify.text);
check("S16: cookie value changes after OTP", owner.cookie !== "" && owner.cookie !== owner.pending);
{
  const old = await http("GET", "/v1/transactions", { headers: { cookie: owner.pending } });
  check("S16: the pre-OTP cookie no longer works", old.status === 401, `${old.status}`);
  const maxAge = /Max-Age=(\d+)/i.exec(owner.verify.headers.getSetCookie().join(";"))?.[1];
  check("10-minute logout: session cookie lasts 12h", maxAge === String(12 * 3600), `Max-Age=${maxAge}`);
  const list = await http("GET", "/v1/transactions", { headers: { cookie: owner.cookie } });
  check("dashboard: transaction list loads with the real cookie", list.status === 200, `${list.status}`);
}
{
  // S6: owner@alpharetail.example exists in Alpha AND Beta. Logging into Beta must give a Beta session.
  const s = await merchantLogin(beta.id, "owner@alpharetail.example");
  const me = await http("GET", "/v1/auth/me", { headers: { cookie: s.cookie } });
  check("S6: same email in two merchants logs into the merchant asked for", me.json?.merchant?.id === beta.id || me.json?.merchantId === beta.id, me.text.slice(0, 200));
}

// ------------------------------------------------------------------ API key for merchant API
const key = await http("POST", `/v1/merchants/${alpha.id}/api-keys`, { body: { label: "smoke" }, headers: { cookie: owner.cookie } });
check("API key: owner can issue one", key.status === 201 || key.status === 200, key.text.slice(0, 200));
const auth = { authorization: `Bearer ${key.json?.rawKey}` };

// ------------------------------------------------------------------ payment link checkout
async function newLink(amountFils: number, expiresInMs = 3_600_000) {
  const r = await http("POST", `/v1/merchants/${alpha.id}/payment-links`, {
    body: { amountFils, expiresAt: new Date(Date.now() + expiresInMs).toISOString(), reference: "smoke" },
    headers: auth,
  });
  return r;
}
{
  const link = await newLink(4_750);
  check("checkout: link created", link.status === 201, link.text.slice(0, 200));
  const token = link.json.token as string;
  check("S2: link token is long and random (>= 22 chars)", token.length >= 22, token);
  const view = await http("GET", `/v1/payment-links/${token}`);
  check("checkout: buyer can load the link", view.status === 200, view.text.slice(0, 200));
  check("S12: public link page leaks no API key data", !/merchantPublicKey|merchantIntegrationId|key_hash/.test(view.text), view.text.slice(0, 300));
  const [a, b] = await Promise.all([
    http("POST", `/v1/payment-links/${token}/pay`, { body: { card: CARD }, headers: { "idempotency-key": randomUUID() } }),
    http("POST", `/v1/payment-links/${token}/pay`, { body: { card: CARD }, headers: { "idempotency-key": randomUUID() } }),
  ]);
  const paid = [a, b].filter((r) => r.status === 200).length;
  check("C1: two buyers paying the same link at once -> exactly one charge", paid === 1, `${a.status} ${b.status}`);
  const charges = await one<{ n: string }>(
    `SELECT count(*)::text n FROM transactions t JOIN payment_links pl ON pl.transaction_id = t.id WHERE pl.token = $1`,
    [token],
  ).catch(() => ({ n: "?" }));
  void charges;
  const again = await http("POST", `/v1/payment-links/${token}/pay`, { body: { card: CARD }, headers: { "idempotency-key": randomUUID() } });
  check("checkout: a paid link can't be paid again", again.status >= 400 && again.status < 500, `${again.status}`);
}
{
  const link = await newLink(1_000, 1_500);
  await new Promise((r) => setTimeout(r, 2_000));
  const r = await http("POST", `/v1/payment-links/${link.json.token}/pay`, {
    body: { card: CARD, submittedAt: new Date(Date.now() - 3_600_000).toISOString() },
    headers: { "idempotency-key": randomUUID() },
  });
  check("FP-187/S10: expired link can't be paid by sending an old submittedAt", r.status >= 400 && r.status < 500, `${r.status} ${r.text.slice(0, 120)}`);
}
{
  const link = await newLink(2_000);
  const betaOwner = await merchantLogin(beta.id, "owner@betadigital.example");
  const r = await http("DELETE", `/v1/merchants/${beta.id}/payment-links/${link.json.id}`, { headers: { cookie: betaOwner.cookie } });
  const still = await http("GET", `/v1/payment-links/${link.json.token}`);
  check("S7: merchant B can't cancel merchant A's link", r.status === 404 && still.status === 200, `${r.status} / link ${still.status}`);
}

// ------------------------------------------------------------------ transactions, capture fee, refunds
async function refundCall(merchantId: string, cookie: string, body: unknown) {
  for (let i = 0; i < 5; i++) {
    const r = await http("POST", `/v1/merchants/${merchantId}/refunds`, { body, headers: { cookie, "idempotency-key": randomUUID() } });
    if (!(r.status === 402 && r.json?.error === "refund_declined")) return r;
    console.log("      (simulated acquirer decline, retrying with a new attempt)");
  }
  throw new Error("declined 5 times");
}
async function sale(fils: number) {
  const a = await http("POST", "/v1/transactions", { body: { amountFils: fils, card: CARD }, headers: { ...auth, "idempotency-key": randomUUID() } });
  const c = await http("POST", `/v1/transactions/${a.json.id}/capture`, { body: { amountFils: fils }, headers: { ...auth, "idempotency-key": randomUUID() } });
  return { id: a.json.id as string, authorize: a, capture: c };
}
let refundTxn = "";
{
  const s = await sale(10_000);
  check("payments: authorize + capture", s.authorize.status === 201 && s.capture.status === 200, `${s.authorize.status} ${s.capture.status}`);
  refundTxn = s.id;
  const ledger = await one<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount_fils ELSE -amount_fils END),0)::text net FROM ledger_entries WHERE transaction_id = $1`,
    [s.id],
  );
  check("ledger: capture entries balance to 0", ledger.net === "0", ledger.net);

  const r1 = await refundCall(alpha.id, owner.cookie, { transactionId: s.id, amountFils: 4_000, reason: "smoke" });
  check("FP-300: partial refund through the API", r1.status === 200 && r1.json.transactionStatus === "partially_refunded", r1.text.slice(0, 200));
  const [x, y] = await Promise.all([
    http("POST", `/v1/merchants/${alpha.id}/refunds`, { body: { transactionId: s.id }, headers: { cookie: owner.cookie, "idempotency-key": randomUUID() } }),
    http("POST", `/v1/merchants/${alpha.id}/refunds`, { body: { transactionId: s.id }, headers: { cookie: owner.cookie, "idempotency-key": randomUUID() } }),
  ]);
  check("C2/FP-209: two refunds of the rest at once -> only one goes through", [x, y].filter((r) => r.status === 200).length === 1, `${x.status} ${y.status}`);
  const row = await one<{ refunded_fils: string; status: string }>(`SELECT refunded_fils::text, status FROM transactions WHERE id = $1`, [s.id]);
  check("FP-300: fully refunded, never more than captured", row.refunded_fils === "10000" && row.status === "refunded", JSON.stringify(row));
  const over = await http("POST", `/v1/merchants/${alpha.id}/refunds`, { body: { transactionId: s.id, amountFils: 1 }, headers: { cookie: owner.cookie, "idempotency-key": randomUUID() } });
  check("M14: nothing left to refund -> refused", over.status === 409 || over.status === 422, `${over.status}`);
  const payable = await one<{ net: string }>(
    `SELECT COALESCE(SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END),0)::text net FROM ledger_entries WHERE transaction_id = $1 AND account_id='merchant_payable'`,
    [s.id],
  );
  check("FP-300 ledger: merchant payable for a fully refunded sale nets to 0 fils", payable.net === "0", payable.net);
  const fee = await one<{ charged: string; back: string }>(
    `SELECT (SELECT COALESCE(SUM(amount_fils),0) FROM ledger_entries WHERE transaction_id=$1 AND account_id='platform_fee_revenue' AND direction='credit')::text charged,
            (SELECT COALESCE(SUM(fee_reversed_fils),0) FROM refunds WHERE transaction_id=$1 AND status='succeeded')::text back`,
    [s.id],
  );
  check("M15: fee given back on refunds == fee charged", fee.charged === fee.back, JSON.stringify(fee));
  const detail = await http("GET", `/v1/transactions/${s.id}`, { headers: { cookie: owner.cookie } });
  const tl = await http("GET", `/v1/transactions/${s.id}/events`, { headers: { cookie: owner.cookie } });
  const timeline = JSON.stringify(tl.json ?? detail.json);
  check("FP-300 timeline: refund events show on the transaction", /refund_partial/.test(timeline) && /"refunded"/.test(timeline), timeline.slice(0, 200));
  const outbox = await one<{ n: string }>(`SELECT count(*)::text n FROM outbox_events WHERE event_type='refund.succeeded' AND aggregate_id=$1`, [s.id]);
  check("FP-300 webhook: refund.succeeded queued for the merchant (x2)", outbox.n === "2", outbox.n);

  const support = await merchantLogin(beta.id, "support@betadigital.example");
  const sup = await http("POST", `/v1/merchants/${beta.id}/refunds`, { body: { transactionId: s.id }, headers: { cookie: support.cookie, "idempotency-key": randomUUID() } });
  check("refund roles: support can't refund", sup.status === 403, `${sup.status}`);
  const betaOwner = await merchantLogin(beta.id, "owner@betadigital.example");
  const cross = await http("POST", `/v1/merchants/${beta.id}/refunds`, { body: { transactionId: s.id }, headers: { cookie: betaOwner.cookie, "idempotency-key": randomUUID() } });
  check("S8: merchant B can't refund merchant A's sale", cross.status === 404, `${cross.status}`);
}

// ------------------------------------------------------------------ reconciliation / reports
{
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 27 * 3600_000).toISOString().slice(0, 10);
  const rec = await http("GET", `/v1/settlement/reconciliation?from=${today}&to=${tomorrow}`, { headers: { cookie: owner.cookie } });
  check("reconciliation: endpoint answers", rec.status === 200, rec.text.slice(0, 200));
  const gap = rec.json?.gapFils ?? rec.json?.unexplainedGapFils ?? rec.json?.differenceFils;
  check("reconciliation: today's sales + refunds leave no unexplained gap", gap === 0, JSON.stringify(rec.json).slice(0, 300));
  const exp = await http("GET", `/v1/transactions/export?from=${today}&to=${tomorrow}`, { headers: { cookie: owner.cookie } });
  check("R4: CSV export streams back", exp.status === 200 && exp.text.split("\n").length > 2, `${exp.status}`);
  const es = await http("GET", "/v1/reporting/export-summary");
  check("S19: export-summary needs a login", es.status === 401, `${es.status}`);
}

// ------------------------------------------------------------------ webhooks SSRF
{
  const r = await http("POST", `/v1/merchants/${alpha.id}/webhook-endpoints`, { body: { url: "https://127.0.0.1/hook" }, headers: { cookie: owner.cookie } });
  const r2 = await http("POST", `/v1/merchants/${alpha.id}/webhook-endpoints`, { body: { url: "https://169.254.169.254/latest" }, headers: { cookie: owner.cookie } });
  check("S18: webhook URL pointing inside our network is refused", r.status === 400 && r2.status === 400, `${r.status} ${r2.status}`);
}

// ------------------------------------------------------------------ acquirer callbacks
{
  const body = JSON.stringify({
    callbackId: `cb_${randomUUID()}`,
    type: "fraud_review.completed",
    transactionId: refundTxn,
    occurredAt: new Date().toISOString(),
    outcome: "cleared",
    note: "smoke",
  });
  const unsigned = await http("POST", "/v1/acquirer/callbacks", { raw: body });
  check("S11: unsigned acquirer callback refused in production", unsigned.status === 401, `${unsigned.status}`);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", ACQ_SECRET).update(`${t}.${body}`).digest("hex")}`;
  const ok1 = await http("POST", "/v1/acquirer/callbacks", { raw: body, headers: { "acquirer-callback-signature": sig } });
  const ok2 = await http("POST", "/v1/acquirer/callbacks", { raw: body, headers: { "acquirer-callback-signature": sig } });
  check("S11: correctly signed callback accepted", ok1.status === 200, `${ok1.status} ${ok1.text}`);
  const notes = await one<{ n: string }>(`SELECT count(*)::text n FROM acquirer_callback_notes WHERE callback_id = $1`, [JSON.parse(body).callbackId]);
  check("FP-201/C5: same callback twice -> one note", ok2.status === 200 && notes.n === "1", `${ok2.status} notes=${notes.n}`);
  const old = Math.floor(Date.now() / 1000) - 3600;
  const stale = `t=${old},v1=${createHmac("sha256", ACQ_SECRET).update(`${old}.${body}`).digest("hex")}`;
  const r = await http("POST", "/v1/acquirer/callbacks", { raw: body, headers: { "acquirer-callback-signature": stale } });
  check("S11: replayed (hour-old) signature refused", r.status === 401, `${r.status}`);
}

// ------------------------------------------------------------------ admin console
{
  const login = await http("POST", "/v1/admin/auth/login", { body: { email: "finance@filspay.test", password: "FilsPayAdminSeed!2026" } });
  const code = await lastOtp();
  const verify = await http("POST", "/v1/admin/auth/otp/verify", { body: { code }, headers: { cookie: cookieOf(login, "fp_admin_sid") } });
  const admin = cookieOf(verify, "fp_admin_sid");
  check("admin: finance can log in (password + OTP)", login.status === 200 && verify.status === 200, `${login.status} ${verify.status} ${login.text.slice(0, 120)}`);
  const merchants = await http("GET", "/v1/admin/merchants", { headers: { cookie: admin } });
  check("admin: merchant list loads", merchants.status === 200, `${merchants.status}`);
  const rebuild = await http("POST", "/v1/admin/balances/rebuild", { body: {}, headers: { cookie: admin } });
  check("FP-203/A1: Rebuild cached balances works through the settlement service", rebuild.status === 200, `${rebuild.status} ${rebuild.text.slice(0, 200)}`);
  const bal = await one<{ cached: string; ledger: string }>(
    `SELECT (SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id=$1)::text cached,
            (SELECT SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END) FROM ledger_entries WHERE merchant_id=$1 AND account_id='merchant_payable')::text ledger`,
    [alpha.id],
  );
  check("FP-203: Alpha's cached balance == its ledger after the button", bal.cached === bal.ledger, JSON.stringify(bal));
}

console.log(`\n${pass} passed, ${fail} failed`);
await db.end();
process.exit(fail ? 1 : 0);

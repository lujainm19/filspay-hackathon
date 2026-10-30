# Handover review — findings index

The full write-up (root cause, why, what it breaks, fix, for every finding)
is the **FilsPay audit — findings and fix plan** report submitted with this
repo. This file is the in-repo index: every finding, its status, and the
test that proves the fix. IDs are the report's IDs (S security, M money,
C concurrency, T settlement timing, A admin console, W webhooks, R
reliability/ops, N found during final end-to-end verification).

AI setup: `CLAUDE.md` (rules, checked against code), `AGENTS.md` and
`.cursorrules` (pointers to it), `.claude/settings.json` (permissions),
`.claude/commands/` (`/verify-finding`, `/full-check`, `/smoke`),
`scripts/ai/fresh_test.sh`, `scripts/e2e_smoke.ts`.

Ghadah's branch notes (`docs/PARTNER_FIXES.md`) used their own labels for
some of the same bugs; the table below is the one to quote.

## How to verify

```bash
npm ci
DATABASE_URL=postgres://... npm run migrate        # 0001–0076 on an empty DB
DATABASE_URL=postgres://... npm test               # 492 TS tests, one run
cd apps/settlement && DATABASE_URL=... go test -p 1 ./...
```

Regression tests for the fixes live in `apps/api/src/**/*.new.test.ts`,
`apps/api/src/partnerRegressions.test.ts`,
`apps/settlement/internal/**/{hackathon,partner,lujain}_fixes_test.go`,
`apps/reporting/src/consumer/refundRollup.test.ts` and `scripts/*.test.ts`.
Old tests that asserted a bug were changed, with the reason written in the
test. Capacity: `scripts/loadtest_checkout.ts` (see "Capacity" below).

## Case-file hints → findings

| Hint | Finding(s) |
| --- | --- |
| FP-187 link paid after expiry | S10 |
| FP-201 duplicate callback notes | C5 |
| FP-203 balance 135K → 7K | A1, N3 |
| FP-209 concurrent refunds | C2 |
| FP-240 webhook signatures | W1, S11 |
| Incident 05-14 link charged twice | C1 |
| Incident 08-21 duplicate payout notices | C3, C4, N1 |
| Refund more than charged | M14 |
| Splits a few fils short | M3 |
| Admin actions without role checks | S13, S14, A5 |
| Key rotation | A3 |
| Daily close timing | T1, N4 |
| Slow reporting query | M11, R6 |
| Test merchants in real settlement | T3 |
| OTP still safe? / login without OTP | S1–S5, S16 |
| Very large upload / export | R4, R5, S17 |
| Scheme total always a few fils higher | M4, M5 |
| March sweep run twice | M16 |
| MDR recalc changed paid batches | T2 |
| Dashboard 245 bps vs 225 charged | M10 |
| CSV import 4.75 → 0.475 | M1 |
| Lifetime payout estimate drifts | M7 |
| Cancelled B's link from A's dashboard | S7 |
| FP-300 refunds (the missing feature) | M14, M15, C2, S8, W-refund webhook, reporting/reconciliation rows below |

## Findings

Owner: **L** Lujain (API, web, admin), **G** Ghadah (Go settlement, reporting,
scripts, DB, ops). Status: ✅ fixed and tested · ⚖️ kept by design (reason given).

| ID | Sev | Finding | Owner | Status | Proof |
| --- | --- | --- | --- | --- | --- |
| S1 | Critical | Password alone logs you in (pending session counted as authenticated) | L+G | ✅ | `auth/loginSecurity.new.test.ts`, 0073 view |
| S2 | High | OTP / link tokens / invite codes from `Math.random` | L | ✅ | `auth/loginSecurity.new.test.ts` |
| S3 | High | OTP brute force with parallel guesses | L | ✅ | `auth/loginSecurity.new.test.ts` |
| S4 | High | OTP resend resets the guess budget | L | ✅ | `auth/loginSecurity.new.test.ts` |
| S5 | High | Hosted login response contained the OTP | G | ✅ | config (prod never exposes) |
| S6 | High | Login bound to another merchant's user with the same email | L | ✅ | `auth/loginSecurity.new.test.ts` |
| S7 | High | Merchant A cancels merchant B's payment link | L | ✅ | `routes/paymentLinks.new.test.ts` |
| S8 | High | Merchant A refunds merchant B's sale | L | ✅ | `routes/refunds.new.test.ts` |
| S9 | High | Any merchant reads any split child's data | L | ✅ | `reporting/scope.new.test.ts` |
| S10 | High | Expired link paid using the browser's clock (FP-187) | G | ✅ | `paymentLinks/pay.test.ts` |
| S11 | High | Unsigned / replayed / re-serialised acquirer callbacks accepted | L+G | ✅ | `webhooks/inboundVerify.test.ts`, `routes/acquirerCallbacks.test.ts` |
| S12 | Medium | Public checkout leaked API key hash and prefix | L | ✅ | `routes/paymentLinks.test.ts` |
| S13 | High | "View as merchant" gave admins write power | L | ✅ | `auth/impersonation.new.test.ts` |
| S14 | Medium | Support / impersonators could capture and void | L | ✅ | `auth/impersonation.new.test.ts` |
| S15 | Medium | Disabled admin's impersonation kept working | L | ✅ | `auth/impersonation.new.test.ts` |
| S16 | Medium | Session fixation (token not rotated after OTP) | L | ✅ | `auth/loginSecurity.new.test.ts`, `partnerRegressions.test.ts` (12 h cookie) |
| S17 | Medium | Weak KYC upload checks (fake PDFs, pixel bombs, many files) | L | ✅ | `onboarding/kyc.new.test.ts` |
| S18 | Medium | Webhook URLs could target internal network (SSRF) | L | ✅ | `webhooks/ssrf.new.test.ts` |
| S19 | Low | `/v1/reporting/export-summary` had no auth | L | ✅ | `requireMerchantAuth` on the route; E2E smoke (401) |
| S20 | Medium | Acquirer secret committed in `ops/.env.docker` | G | ✅ | untracked; `ops/gen-secrets.sh` generates a fresh one per deploy |
| S21 | Low | CSV formula injection in the export | L | ✅ | `transactions/exportCsv.new.test.ts` |
| M1 | Critical | CSV import 10× too small (4.75 → 0.475) | L | ✅ | `admin/adjustmentCsvParsing.test.ts` |
| M2 | High | Same CSV could be imported twice | L+G | ✅ | `admin/adjustmentImport.new.test.ts` (0073 index) |
| M3 | High | Split payouts a few fils short | G | ✅ | `splits/hackathon_fixes_test.go` |
| M4 | High | Scheme file rounded up, always above our total | G | ✅ | `settlement/hackathon_fixes_test.go` |
| M5 | High | Scheme rounding residue never journaled | G | ✅ | `settlement/lujain_fixes_test.go` |
| M6 | High | Net payout via float32 | G | ✅ | `settlement/hackathon_fixes_test.go` |
| M7 | Medium | Lifetime payout estimate drifts (REAL column) | G | ✅ | 0073 BIGINT, `settlement/payout_estimate_test.go` |
| M8 | High | Platform volume counter overflows (int32) | G | ✅ | `settlement/hackathon_fixes_test.go` |
| M9 | High | Capture fee ≠ settlement fee (fee order) | L | ✅ | `payments/captureFee.new.test.ts` |
| M10 | Medium | Dashboard showed 245 bps, charged 225 | L | ✅ | `fees/currentFeeScheduleDisplay.test.ts` |
| M11 | High | Settlement summary ~38% high for multi-capture | L+G | ✅ | `routes/settlement.test.ts` |
| M12 | Medium | Reconciliation "pending" figure wrong | L+G | ✅ | `routes/settlement.test.ts` |
| M13 | Medium | Credits booked at the chosen effective date | — | ⚖️ | ARCHITECTURE prescribes the effective date as the accounting date |
| M14 | High | Refund could exceed what was captured | L | ✅ | `routes/refunds.new.test.ts` |
| M15 | Medium | Refund fee reversals could exceed the fee | L | ✅ | `routes/refunds.new.test.ts` |
| M16 | High | March sweep not idempotent, wrong accounts | G | ✅ | `scripts/reconcile_march.test.ts` |
| M17 | Low | Refund summary view joined the wrong column | G | ✅ | 0073, `refundRollup.test.ts` |
| C1 | Critical | One link charged twice (incident 05-14) | G | ✅ | `paymentLinks/pay.test.ts`, `partnerRegressions.test.ts` |
| C2 | Critical | Two refunds at once both paid out (FP-209) | L | ✅ | `routes/refunds.new.test.ts`, `payments/refundReservation.new.test.ts` |
| C3 | High | Duplicate `settlement.paid` (incident 08-21) | G | ✅ | 0073 unique index + `ON CONFLICT`, `settlement/payout_notify_test.go` |
| C4 | High | Payout disbursement duplicated on replay | L+G | ✅ | `webhooks/dispatcher.new.test.ts` |
| C5 | High | Same acquirer callback saved twice (FP-201) | L+G | ✅ | `routes/acquirerCallbacks.test.ts` |
| C6 | Medium | Two retries of a failed payment could both charge | L | ✅ | `payments/idempotency.new.test.ts` |
| C7 | Medium | Reporting double-counts / skips around the cursor | G | ✅ | `runConsumerPass.test.ts` |
| C8 | Low | Two dispatchers would deliver twice | — | ⚖️ | Exactly one API replica by design (compose); noted for scale-out |
| T1 | High | Daily close at ~03:00 Bahrain (UTC date) | G | ✅ | `settlement/hackathon_fixes_test.go` |
| T2 | High | MDR recalculation rewrote paid batches | G | ✅ | `settlement/lujain_fixes_test.go`, `partner_fixes_test.go` |
| T3 | High | Recompute statuses took test merchants out of test mode | L | ✅ | `routes/adminRecompute.new.test.ts` |
| T4 | Medium | Daemon and CLI could close/notify at the same time | G | ✅ | advisory lock, `partner_fixes_test.go` |
| W1 | High | Signed sorted JSON, sent different bytes (FP-240) | L | ✅ | `webhooks/dispatcher.new.test.ts` |
| W2 | Medium | Replays got a new dedupe id and re-ran payout effects | L | ✅ | `webhooks/dispatcher.new.test.ts` |
| W3 | Medium | One unbuildable event stalled every delivery | L | ✅ | defensive guard in `dispatcher.ts` |
| W4 | Low | Huge webhook response could OOM the API | L | ✅ | `webhooks/ssrf.new.test.ts` (capped read) |
| A1 | High | Rebuild balances button dropped Alpha 135K → 7K (FP-203) | G | ✅ | `ledger/refresh_test.go`, E2E smoke |
| A2 | Medium | Adjust balance is cache-only | — | ⚖️ | ADR-0006: by design; the ledger is authoritative, Rebuild restores it |
| A3 | High | Key rotation left the old key working forever | L | ✅ | `payments/refundReservation.new.test.ts` (24 h overlap, then refused) |
| A4 | Medium | Two-person credit approval compared display names | L | ✅ | `admin/creditApproval.test.ts` |
| A5 | Medium | Bulk KYC approve hit merchants in any state | L | ✅ | `routes/admin.test.ts` |
| A6 | Low | Rebuild analytics double-counted | G | ✅ | `admin/reportingRebuild.new.test.ts`, reporting `runRebuild` test |
| R1 | Critical | Migrations failed on a fresh database | G | ✅ | `npm run migrate` 0001–0076 clean |
| R2 | Critical | Stack didn't build or boot | G | ✅ | `ops/` Dockerfiles, compose |
| R3 | Critical | `expire_holds` deleted all holds when none expired | G | ✅ | `scripts/expire_holds.test.ts` |
| R4 | High | Large export OOMs the 512 MB API | L | ✅ | `transactions/exportCsv.new.test.ts` (streamed) |
| R5 | Medium | Webhook archive loaded any range into memory | L | ✅ | `webhooks/archiveReplay.test.ts` |
| R6 | Medium | Slow reporting queries | L | ✅ | migration 0075, sargable `analytics/query.ts` |
| R7 | Medium | Reporting worker wedged on a bad event | G | ✅ | dead letters, `runConsumerPass.test.ts` |
| R8 | Low | `/readyz` green after the DB dies | G | ✅ | `/healthz/db` live probe, used by the compose healthcheck |
| R9 | Low | Seeding wiped tables it doesn't own | G | ✅ | seed refuses a non-seed DB |
| R10 | Medium | Float / cents helpers waiting for a caller | L+G | ✅ | `fees/estimate.new.test.ts`; unsafe helpers deleted |
| N1 | High | A merchant's 2nd webhook endpoint never got `settlement.paid` (0073's one-per-batch index + per-endpoint effect) | L | ✅ | `webhooks/dispatcher.new.test.ts` |
| N2 | High | Nobody could log in on the hosted box (prod OTP had no channel) | L | ✅ | `auth/notifier.new.test.ts`, `OTP_LOG_CODES` |
| N3 | Low | `rebuild-balances --merchant` printed but never saved | L | ✅ | `ledger/lujain_fixes_test.go` |
| N4 | Low | Daemon logged "next check-in" as now + 24 h in UTC | L | ✅ | `scheduler/status_test.go` |
| N5 | Low | Test fixture made `npm test` fail in one run (poison events) | L | ✅ | full suite green in one run |
| N6 | High | Reconciliation showed a fake gap equal to the payouts for any period longer than a day | L | ✅ | `routes/settlement.test.ts` (two-day test) |

## Team decisions (option chosen where two fixes were possible)

Session rotation after OTP: rotate. API key rotation: 24 h overlap via
`revoke_after`. Webhook replay: allowed, same dedupe id, no side effects.
Refund race: reserve → acquirer with no lock → settle, with crash recovery.
Fee order: discount off the amount, then MDR. Analytics rebuild: reset
cursor and replay. Details: `docs/PARTNER_FIXES.md` §3 and §7.

## Capacity (measured, API capped at 0.5 vCPU / 512 MB)

`scripts/loadtest_checkout.ts` (create link → load → pay), production mode:

| Buyers at once | Checkouts/s | p95 |
| --- | --- | --- |
| 10 | 17.9 | 0.77 s |
| 20 | 35.1 | 0.78 s |
| 40 | 44–46 | 1.1 s |
| 80–300 (clients honour `Retry-After`) | ~45 | 1.4–1.6 s, excess gets 503 |

Peak memory 168 MB. Submitted estimate: **~20 concurrent buyers / ~35
checkouts/s while p95 stays under 1 s; ~45 checkouts/s maximum.** Past that
the API answers 503 + `Retry-After` instead of queueing. `kill -9` mid-load
(checkouts and concurrent refunds): after restart every ledger group
balances, no link is charged twice, no sale is over-refunded, and the
recovery jobs finish stuck links and pending refunds within ~2 minutes.

## Not done here

Deploying to Dilmune Cloud needs the team's account:
`./ops/gen-secrets.sh && docker compose -f ops/docker-compose.yml up -d --build`
(set `OTP_LOG_CODES=true` in `ops/.env` so codes can be read from
`docker compose logs api`).

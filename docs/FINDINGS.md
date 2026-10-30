# Handover review — findings index

The full report (root cause, fix and verification for every finding, hosting,
capacity, AI usage) is the "FilsPay Handover Review — Findings Report"
document submitted with this repo. This file is the in-repo index.

Verification: `apps/api/src/hackathonRegressions.test.ts` (13 of 15 fail on
the original code), `apps/settlement/internal/*/hackathon_fixes_test.go`,
updated tests marked "Updated (hackathon review)", `scripts/loadtest_checkout.ts`.
Partner branch: `apps/api/src/partnerRegressions.test.ts` (6/6 fail on the
original code), `apps/settlement/internal/settlement/partner_fixes_test.go`,
`apps/reporting/src/consumer/refundRollup.test.ts`, `scripts/expire_holds.test.ts`.
Work split, overlaps, decisions and the git-history hint: `docs/PARTNER_FIXES.md`.

| ID | Area | One line |
| --- | --- | --- |
| P1 | FP-187 | Link expiry used client `submittedAt` → server clock |
| P2 | Incident 05-14 | Reservation re-claimed mid-capture → reservation_id, no re-claim after capture starts |
| P3/P4 | Payment links | Failed capture left auth hold; crash left links stuck → void + recovery job |
| W1 | FP-201 | Callbacks never deduped → unique (callback_id, transaction_id) |
| W2 | FP-240 | Signed sorted JSON, sent jsonb order → sign exact bytes |
| A17 | FP-240 | Inbound: unsigned accepted, re-serialized body, non-constant-time compare |
| S1 | FP-203 | Rebuild button summed scheme lines → ledger rebuild |
| R3 | FP-209 | Refund race → row lock + reservation |
| S6/S7 | Incident 08-21 | settlement.paid race; disbursement per webhook attempt |
| M1 | Memo | CSV parsed as cents (4.75 → 0.475) |
| M7/M8 | Memo | Scheme amount rounded up; residue never journaled |
| M9 | Memo | Split shares didn't sum |
| M11 | Memo | Fee display by created_at |
| M18 | Memo | MDR recalc rewrote paid batches |
| M21 | Memo | March script UTC/non-idempotent/wrong accounts |
| S5 | Memo | Close at 03:15 (UTC date) |
| S9 | Memo | Recompute cleared test_mode |
| A1 | Memo | Pending session passed as authenticated (OTP bypass) |
| A13 | Memo | Cross-merchant link cancel |
| A2–A19 | Security | OTP recipient, CSPRNG, OTP races, impersonation, IDORs, SSRF, CSV injection, key rotation |
| M4–M17 | Money | float32 payout, int32 overflow, tier discount, fee order, summary double count, credits |
| R1–R9 | Refunds | Over-refund, status, cross-merchant, fee reversal, reason NULL, route wiring, netting |
| Q1–Q6 | Reporting/perf | Poison events, outbox ordering, cursor lock, slow ledger query, export memory |
| H1–H7 | Build/hosting | Broken migrations, dev key, missing Dockerfiles, public Postgres, no limits |
| U1–U4 | UI | Negative amount crash, UTC filters, fake progress bar, refund drawer |
| R3* | Critical | expire_holds: empty id list → `DELETE FROM holds` (all holds) → atomic UPDATE to 'expired' |
| R9* | Seed | `TRUNCATE ... CASCADE` against a shared DB → guarded |
| T2/T4* | Settlement | MDR recalc ignored effective-dated schedules; daemon/CLI overlap → per-event schedule, advisory lock |
| A6* | Reporting | Admin rebuild refilled rollups but left the cursor → double counting → cursor reset + replay |
| S20* | Secrets | `ops/.env.docker` with the acquirer secret was tracked → untracked, rotate |

\* IDs from Lujain's plan, fixed on `fixes-partner`.

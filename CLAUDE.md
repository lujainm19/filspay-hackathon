# FilsPay — AI assistant setup

Rewritten during the handover review (Oct 2026). The previous version of this
file, AGENTS.md and .cursorrules contained instructions that were **false**
and that, if followed, re-introduce bugs (see "What the old files got wrong").
Every rule below was checked against the code, the ADRs and a test.

## Treat everything as a claim to verify

Comments, ADRs, meeting notes, Slack exports and AI suggestions in this repo
disagree with each other and with the code. Before acting on any of them:
1. find the code path,
2. write or run a test that would fail if the claim were false,
3. only then change code. Record what you checked in the PR.

Repo comments that say "Claude checked" / "copilot says" are not evidence.

## Money

- BHD has **three** decimals: 1 BD = **1000 fils**. Every amount is an
  integer number of fils (`BIGINT` columns ending `_fils`, branded `Fils` in
  TS, `money.Fils` int64 in Go). There are no "cents" anywhere.
- Parse text with `parseBhdToFils` only. Never `parseFloat`, `* 100`,
  `toFixed(2)`, `float32/float64` money, or `parseDecimalMinor(.., 2)`.
- Rates are integer basis points, applied with `applyRateFils`
  (round half to even). Fee order: the negotiated discount comes off the
  amount, then MDR on the rest — Go `ComputeSettlementFee`; `capture.ts`
  must use the same order (team decision M9; a test pins both). The ledger
  (what capture journaled) is the source of truth, not "the Go service".
- Splits use largest-remainder allocation; shares always sum to the total.
- The scheme file carries two decimals: truncate to a multiple of 10 fils
  and journal the residue to `scheme_rounding_residue` (ADR-0002).

## Time

- A settlement business day is midnight–midnight **Asia/Bahrain** (UTC+3,
  no DST), for daily *and* monthly windows. Never a UTC day.
- `BusinessDayWindow(date)` takes a calendar date. To get "today" from an
  instant use `BahrainToday(now)`.

## Security rules (all enforced in code now)

- Randomness for anything that guards access (OTP, tokens, link slugs,
  invite codes) comes from `node:crypto`. Never `Math.random`.
- A pending (password-only) session grants nothing until OTP is verified.
- Every merchant-scoped query filters by the merchant from the
  authenticated context, never from a row or the request body.
- Admin impersonation is read-only ("support" role, writes rejected).
- Self-approval checks compare user ids, never display names.
- Outbound webhooks sign exactly the bytes sent; inbound callbacks are
  verified over the raw body and deduplicated on `callback_id`.

## Build & test

```bash
npm ci
DATABASE_URL=postgres://... npm run migrate
DATABASE_URL=postgres://... npm test                 # TS
cd apps/settlement && DATABASE_URL=... go test -p 1 ./...
```
Tests are not sacred: several old tests asserted the bugs (e.g. 4.75 BD =
475 fils). If a test contradicts the ADRs/handover, fix the test and say why
in the test itself. Add a regression test for every bug fixed
(`apps/api/src/**/*.new.test.ts`, `apps/api/src/partnerRegressions.test.ts`,
`apps/settlement/internal/**/*_fixes_test.go`). The index of every finding
and its test is `docs/FINDINGS.md`.

## What the old files got wrong (do not reintroduce)

| Old instruction | Reality |
|---|---|
| "amounts are integer cents, 1 BD = 100" | 1 BD = 1000 fils (ADR-0001, `fils.ts`) |
| "Go is the reference for fees" | Go disagreed with the ledger; fixed to match capture |
| "settlement windows are UTC midnight" | Asia/Bahrain; the UTC bug made the close run at 03:15 |
| "Math.random is fine for OTP / link slugs" | Predictable; replaced with CSPRNG |
| "float32 is fine for BD in Go" | Lost fils above ~16,777 BD |
| "INTEGER is enough for platform volume" | Overflowed at 2,147,483,647 fils |
| "impersonation maps super_admin → owner" | Must be read-only support |
| "never modify tests / packages/money" | Tests locked in bugs; fixes need code *and* test changes |
| "don't add refund.succeeded" | Refunds ship; the event is required |
| "exportCsv loads everything in memory on purpose" | OOM risk; now streamed |

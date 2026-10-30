# Partner branch (`fixes-partner`) — what is in it and how it fits Lujain's

Author: Ghadah. Base: `8b58b0f` (original `main`). Lujain's branch:
`fixes-lujain/feature-refunds` (TypeScript API + front ends).

## 1. Scope, mapped to Lujain's "Fix order and owners" table

| Plan row | Items | Commit |
| --- | --- | --- |
| 1. Unblock hosting | R1 Dockerfiles/compose, R2 migrations 0054/0055, S20 tracked secret | `hosting: R1 R2 S20` |
| 2. Criticals | R3 expire_holds wiped all holds | `R3 (critical)` |
| 3. FP-300 settlement side | batch netting, reporting consumer, reconciliation | `settlement: criticals + high` (netting), `FP-300 settlement side` |
| 4. High settlement & ops | T1–T4, M3–M6, M8, M16, A1, C3, C4 | `settlement: criticals + high`, `R9 + FP-118` |
| 5. Medium/low (my files) | A6 analytics rebuild, refund-adjustment unit bug, R9 seed | `FP-300 settlement side`, `settlementClient`, `R9 + FP-118` |

### Extras that were not in Lujain's plan

| Extra | Commit |
| --- | --- |
| Payment link crash recovery + void the card hold when capture fails | `payment links: crash recovery ...` |
| The 10-minute logout (cookie never extended after OTP) | `auth: the "10-minute logout"` |
| Migration 0054 (and 0055) break on a fresh database | `hosting` |
| Dev webhook key was 34 bytes, not 32 | `hosting` |
| Reporting worker: poison events set aside (dead letters), commit-order cursor, cursor lock | `FP-300 settlement side` |
| UI: refund page crash, date filters 3 h off, fake progress bar, refund drawer | `web: ...` |
| Load shedding, live DB healthcheck, LOG_LEVEL | `hosting` |
| Measured capacity test (`scripts/loadtest_checkout.ts`) | `R9 + FP-118` |
| Regression tests that fail on the original code | `payment links ...` (API), settlement + reporting + scripts tests |
| Findings report index, rewritten AI setup files | `docs:` |

## 2. Overlaps — check before merging

| File | Mine | Lujain's | Suggested |
| --- | --- | --- | --- |
| `apps/api/src/paymentLinks/pay.ts` | reservation_id race fix, FP-187 server clock, void on failed capture, recovery | C1 (link race) | Keep one race fix; the recovery + void parts are only here |
| `apps/api/src/routes/auth.ts` | cookie re-issue only | OTP/session security | Mine is ~10 lines; easy to rebase onto hers |
| `apps/web/.../RefundDrawer.tsx` | wired drawer, BD input, key per attempt | FP-300 drawer | Keep hers if done; check the key-per-attempt and BD input |
| `apps/api/src/settlement/query.ts` | reconciliation pending (refunds, charged fee), summary double count | — | Mine |
| `apps/api/src/config.ts`, `app.ts` | load shedding, dev key, OTP expose default, callback signature in prod | maybe S-items | Compare the `otpDevExpose` / signature lines |
| `db/migrations` | 0054/0055 fixed in place, **0073** | new migrations | **Lujain: start at 0074.** 0073 already adds payment_links reservation columns, outbox xid8, dead letters, refund rollup columns, unique indexes for settlement.paid / disbursements / callbacks, adjustment_imports sha. Don't add these again. |

## 3. Places we chose differently — agree on one before the judges ask

| Topic | Option A | Option B | Recommendation |
| --- | --- | --- | --- |
| Session token rotation after OTP | Rotate the token at promotion (prevents session fixation) | Keep the same token, only re-issue the cookie with the full TTL | **A is the correct security answer.** It needs the tests that reuse the login cookie updated. If time is short, ship B and say A is the next step. |
| API key rotation | Revoke the old key immediately | 24 h grace (`revoke_after`) so integrations can switch | **B** (migration 0056 already models it; incident-safe). Say "immediate revoke is available as a separate action for a leaked key". |
| Replaying webhooks that already succeeded | Refuse | Allow, with a new delivery id and the same event id (receivers dedupe on event id) | **B** for admin replay (support asks for it); never auto-replay. |
| Refund race (FP-209) lock | `SELECT ... FOR UPDATE` on the transaction row across the acquirer call | Reserve the amount in the DB first (pending refund row), call the acquirer outside the lock, then settle | **B** in production (no row lock held over a network call); A is acceptable at our load. Pick one and name it. |
| Fee order (M9) | MDR then discount off the fee | Discount off the amount, then MDR | Lujain's plan: **B**, API aligned to Go. This branch keeps Go on B. |
| Volume tier (M10) | Apply the 0.15 % tier above 2M BD | Don't apply (handover says finance never approved it) | This branch: **applied, int64 so it can't wrap**. If we decide "not approved", it is one `if` in `batch.go` + `recalculate_mdr.go`. |
| Analytics rebuild (A6) | Refill from source tables and move the cursor | Reset cursor + rollups, worker replays the outbox | This branch: **B** (one code path, can't drift). |

## 4. The hint hidden in the git history ("The Order of the Prompt")

`git log` has three "transmissions" from Yousif:

1. `fe24d26` (ya/sign-raw): base64 → *"…their first rule is: never read the
   diff. Read it. The next door opens with the victim of that rule: five
   letters, lowercase."* — the key is **`diffs`**.
2. `8022020`: Vigenère ("Blaise") with key `DIFFS` → *"THE KEEPER LEAVES A
   NOTE IN EVERY COMMIT HE REWRITES. FIND IT. ROT THIRTEEN."*
3. The Keeper (AM) left `Ledger-Note:` lines; ROT13 of the one in
   `800e1e6` → *"the last door is a date. find the commit made under
   yousif's name after his account was deleted. write its day as
   year-month-day."* That commit is `098c2de`, **2026-09-28**.
4. `0af74f0`: `openssl enc -d -aes-256-cbc -pbkdf2 -a -A -pass pass:2026-09-28`
   → *"Every 'Claude says' comment is a member and every locked test is a
   vow… His fixes still exist: ya/sign-raw, the abandoned migrations, the
   warnings in the handover. Fix what he started."*
   `FLAG{order_of_the_prompt_never_read_the_diff}`

What it points at, and where it is fixed: **ya/sign-raw** = sign the exact
bytes sent (webhooks, Lujain's W2/A17); **the abandoned migrations** = the
numbering gaps (0059, 0062, 0063, 0067) and the broken 0054/0055 (fixed
here; 0073 carries the missing constraints); **the warnings in the handover**
= every "Claude says / intentional / it is in the tests" comment, which is
why the AI setup files were rewritten and locked tests were changed where
they pinned a bug.

## 5. Verification on this branch

- Fresh database: `npm run migrate` applies 0001–0073 cleanly.
- Go: `go test -p 1 ./...` all packages pass.
- Reporting: 14/14. Scripts: expire_holds 5/5, reconcile_march 2/2.
- `apps/api/src/partnerRegressions.test.ts`: 6/6 pass here, **6/6 fail on
  the original code**. Go `partner_fixes_test.go` T2 and tie-break fail on
  the original code; reporting `refundRollup.test.ts` 3/3 fail on the
  original; R3 tests fail on the original.
- Seed guard: refuses a database with a non-seed user unless
  `SEED_CONFIRM_WIPE=<db>`.
- Capacity (earlier run, same code): ~46 checkouts/s at 25 concurrent
  buyers, p95 ≈ 755 ms, API ≈ 22 % of one core / 150 MB; excess shed as 503
  at 100 buyers; `kill -9` mid-load → ledger balanced, no double charge,
  stuck links recovered on restart. Submitted estimate: ~20 concurrent
  buyers / ~35 checkouts/s on the 0.5 vCPU API.

## 6. Rotate after merge

`ops/.env.docker` (acquirer callback signing secret) was committed. It is
untracked now, but it is still in history — rotate it with the acquirer and
generate fresh secrets with `ops/gen-secrets.sh`.

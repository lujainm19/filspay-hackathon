# Postmortem: incident 2026-05-14 — payment links captured more than once

| | |
|---|---|
| **Status** | Closed (2026-05-22) |
| **Severity** | SEV-2 (customer money, contained to two merchants) |
| **Owner** | Mahmood Khalil |
| **Authors** | Fatima Haji (draft), Mahmood Khalil (review) |
| **Detected by** | Support (merchant phone calls) |
| **Duration** | 2026-05-13 22:47 – 2026-05-14 11:20 Bahrain (12 h 33 m), monitoring until 17:30 |
| **Related** | FP-198, FP-212, #fp-ops thread 2026-05-13 (docs/archive/slack-export-fp-ops-2026-05.txt) |

## Summary

Between the evening of 13 May and the morning of 14 May, eight single-use
payment links belonging to Gamma Hospitality Group and Delta Marketplace
Bahrain were paid by more than one cardholder. Seventeen captures were
recorded against eight links; nine of them should not have happened. Three
of the extra captures were included in the 13 May settlement batch before
they were noticed and were made good with goodwill credits. The rest were
voided.

The root cause was duplicate acquirer callbacks. When the acquirer sandbox
retried a capture callback, `POST /v1/acquirer/callbacks` applied it a second
time because callbacks were not deduplicated, and the second application
produced a second capture against the link's transaction. A hotfix adding
callback deduplication (`processed_events`) was deployed at 11:20 on 14 May.

## Impact

| Merchant | Links affected | Captures | Extra captures | Settled before detection | Remediation |
|---|---|---|---|---|---|
| Gamma Hospitality Group | 2 | 4 | 2 | 0 | Voided |
| Delta Marketplace Bahrain | 6 | 13 | 7 | 3 | 4 voided, 3 credited (BD 1,284.500 total) |
| **Total** | **8** | **17** | **9** | **3** | |

- No other merchant was affected. Alpha Retail and Beta Digital Services
  had no payment-link activity in the window.
- Two Gamma holds stayed `active` after the extra captures were voided. They
  were released by hand on 14 May.
- Cardholders were not charged twice by the scheme for the voided captures
  (voids reached the acquirer before clearing).

## Timeline (Asia/Bahrain)

| Time | Event |
|---|---|
| 13 May 21:58 | First double payment (Gamma, FP-PL-8841). Not reported until later. |
| 13 May 22:47 | Support (Noor) reports two receipts on one Gamma deposit link. |
| 13 May 23:05 | AM confirms two captures per link; captures are 60–70 s apart. |
| 13 May 23:14 | Two `acquirer_callback_notes` rows found for the Gamma link. Working theory: duplicate callback. |
| 14 May 00:05 | Daily settlement close for 13 May runs; three Delta Marketplace extra captures are batched. |
| 14 May 03:10 | Support (Sayed) reports four more doubles overnight, all Delta Marketplace. FP-PL-8853 has three captures. |
| 14 May 08:05 | Incident declared. Payment links paused for Delta Marketplace. |
| 14 May 08:30 | FH reports holds staying `active` after void on two Gamma transactions. |
| 14 May 09:52 | Finance given the list; credits issued for the three settled captures. |
| 14 May 11:20 | Hotfix deployed: callbacks deduplicated on `callbackId`. Links re-enabled. |
| 14 May 16:48 | One further double reported (FP-PL-8902). Attributed to a link page cached before the deploy. |
| 14 May 17:30 | Incident marked resolved, monitoring. |
| 22 May 13:20 | Postmortem closed. |

## Root cause

The acquirer sandbox occasionally re-sends a capture callback when our
acknowledgement takes longer than its timeout. Before the hotfix, the
callback handler (`apps/api/src/acquirer/callbacks.ts`) applied every callback
it received. For a payment link whose capture was still in progress, the
re-sent callback was treated as a fresh capture result for the link, so the
link was finalised twice and the second cardholder's capture was accepted.

Supporting evidence:

1. Two `acquirer_callback_notes` rows exist for the first Gamma link.
2. Every affected link had a capture that took longer than 60 s at the
   acquirer, which is when the sandbox retries.
3. No doubles were reported for links created after the hotfix, except
   FP-PL-8902 (see below).

The link claim itself was ruled out. The claim in
`apps/api/src/paymentLinks/pay.ts` is a single `UPDATE ... WHERE status =
'open'`, which Postgres re-evaluates under READ COMMITTED, so two concurrent
payers cannot both claim the same link. This was confirmed independently
with an AI review of `pay.ts` and `void.ts`.

### Why the holds stayed active

The extra capture arrived after the void had already released the hold, and
the late callback set the hold back to `active`. This is the same duplicate
callback and needs no separate fix.

### FP-PL-8902

Created at 15:02, after the hotfix. The customer's phone showed a cached copy
of the link page and the second payment was submitted from it. This is a
client-side caching issue, not a recurrence. See action item 6.

## What went well

- Support escalated within an hour of the first merchant call.
- Finance had a list of settled captures before the 14:00 cut-off.
- Pausing links for one merchant contained the impact without a global
  switch-off.

## What went wrong

- Callback deduplication was assumed to exist. ARCHITECTURE §5 says anything
  FilsPay receives is deduped before it's applied, and nobody had checked.
- There is no alert on "more than one capture per payment link".
- The incident was declared nine hours after the first report.
- Refunds (FP-212) are not available, so settled extras had to be handled as
  goodwill credits, which distorts the merchant's fee figures.

## Action items

| # | Action | Owner | Ticket | Status |
|---|---|---|---|---|
| 1 | Deduplicate acquirer callbacks on `callbackId` (`processed_events`) | MK | FP-201 | Done (2026-05-14) |
| 2 | Add a unique constraint so a payment link can have at most one successful capture | AM | FP-202 | Done |
| 3 | Alert when a link has more than one capture in 24 h | AM | FP-205 | Not started |
| 4 | Release holds on void even when a late callback arrives | FH | FP-206 | Done (covered by #1) |
| 5 | Investigate overlap with FP-198 (timing-dependent batch claims) | MK | FP-198 | In progress |
| 6 | `Cache-Control: no-store` on the hosted link page | AM | FP-207 | Done |
| 7 | Settlement daemon to take an advisory lock before closing a day (`SETTLEMENT_SINGLETON_LOCK=1`) so a slow close can't overlap a CLI run | MK | FP-208 | Done |
| 8 | Prioritise FP-212 refunds so extras can be refunded instead of credited | MK | FP-212 | Scheduled |
| 9 | Add callback replay to the acquirer simulator test suite | FH | — | Done (`callbacks.test.ts`) |

## Appendix A: queries used

```sql
-- links with more than one capture
SELECT pl.id, pl.token, count(*) AS captures
  FROM payment_links pl
  JOIN transactions t ON t.payment_link_id = pl.id
 WHERE t.captured_fils > 0
   AND t.created_at >= '2026-05-13T18:00:00Z'
 GROUP BY pl.id, pl.token
HAVING count(*) > 1;

-- callback notes per transaction in the window
SELECT transaction_id, count(*)
  FROM acquirer_callback_notes
 WHERE created_at >= '2026-05-13T18:00:00Z'
 GROUP BY transaction_id
 ORDER BY 2 DESC;
```

Result of the second query on 14 May at 09:00: 17 rows, `count = 1` for 16
of them and `count = 2` for one (the first Gamma transaction). The doubles
are on different transactions, which is consistent with the sandbox re-using
callback ids.

## Appendix B: reviewer notes

> **AM (2026-05-22):** for the record I still think the 60 s thing is the
> reservation timeout in pay.ts, not the acquirer retry. Every double had a
> first attempt over 60 s, and 16 of 17 transactions have exactly one
> callback note. Not blocking the close.
>
> **MK:** the retry window is also ~60 s. Same evidence fits both. Callback
> dedupe is the fix we can verify; we've had no doubles since.


## Correction (Oct 2026 review)

The root cause above is wrong; AM's reviewer note was right. Callback
deduplication never existed (no `processed_events`, no unique key — FP-201 was
reopened), and the evidence (one callback note per transaction, every double
had a first attempt > 60 s, three captures on FP-PL-8853, FP-PL-8902 created
*after* the "fix") points at `pay.ts`: a reservation older than the 60 s
timeout could be re-claimed while the first payer's capture was still running,
and the late finalize matched 0 rows but still answered 200. The "AI review"
that cleared `pay.ts` only looked at the claim UPDATE, not at what happens
after the reservation expires.

Fixed: per-claim `reservation_id`, a link whose capture has started can't be
re-claimed, finalize only matches its own reservation, failed captures void
their authorization, and a recovery job resolves links left mid-capture by a
crash. Callbacks are now deduplicated on (callback_id, transaction_id).

# 0003. Date windows for reports and finance scripts

- **Status:** Accepted
- **Date:** 2026-02-26
- **Deciders:** Mahmood Khalil
- **Supersedes:** the "business day everywhere" note in ARCHITECTURE §3, for
  calendar-month reports only

## Context

ARCHITECTURE §3 says every query that windows activity by date uses the
Asia/Bahrain business day. That makes sense for daily batches. For
calendar-month finance reports it adds complexity: every report needs the
`BusinessDayWindow` helper, and a month boundary in Bahrain time is not a
month boundary in the database, which stores UTC.

The settlement report hotfix (7e612cb) also needed a quick window that
finance could reproduce in a spreadsheet.

## Decision

- **Daily** windows (batches, the settlement report for a single day, the
  daemon) use the Asia/Bahrain business day via `BusinessDayWindow`.
- **Calendar-month** windows for finance reports and one-off scripts use
  the UTC calendar month: `[YYYY-MM-01T00:00Z, next month 01T00:00Z)`.
- The difference at month boundaries is three hours on each side. Over a
  full month the activity moved out at the start is offset by activity
  moved in at the end, so monthly totals are equivalent for reconciliation
  purposes.

## Consequences

- Monthly scripts are simpler and can be checked in a spreadsheet without
  timezone conversion.
- A monthly figure and the sum of that month's daily batches can differ
  by the first three Bahrain hours of the month and the first three of the
  next. Finance has accepted this.
- If a month has unusual volume at the boundary, compare against the batch
  totals before booking.

## Notes

> **YA (2026-03-02):** I don't agree with this. The three hours don't "net
> out", they belong to a different month. Every window that is compared to
> batches has to use the same day.
>
> **MK:** noted. Keeping it for monthly reports, revisit if a month doesn't
> tie.


## Superseded (Oct 2026 review)

YA was right: the three hours do not "net out", they belong to a different
month, and March never tied because of it. All windows — daily and monthly —
use the Asia/Bahrain business day. `scripts/reconcile_march.ts` now uses the
Bahrain month.

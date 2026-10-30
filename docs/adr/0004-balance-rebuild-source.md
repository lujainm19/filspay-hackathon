# 0004. Balance cache rebuild source

- **Status:** Accepted
- **Date:** 2026-05-30
- **Deciders:** Mahmood Khalil
- **Related:** FP-203, 834f6b0, ADMIN.md "Rebuild cached balances"

## Context

`merchant_balances.cached_payable_fils` is a cache. The CLI
`settlement rebuild-balances` recomputes it by walking `ledger_entries`. On
the production dataset this takes ~40 s with the table cold, which is too
long for an admin button behind an HTTP request with a 30 s timeout.

Support needs a button. Finance needs the figure to match what was actually
exported to the scheme.

## Decision

The console button rebuilds from a faster query path using settled data
instead of walking the full ledger. It reflects what actually left the
platform, which is the figure finance reconciles against.

The CLI keeps the ledger walk for engineering use.

## Consequences

- Two rebuild paths exist. They agree whenever the cache is consistent with
  settled activity.
- Manual corrections made with **Adjust balance** are cache-only, so
  they are overwritten by a rebuild and must be re-applied afterwards.


## Superseded (Oct 2026 review, FP-203)

The "faster query path" summed scheme export lines — gross batched captures
with fees, payouts, refunds and credits ignored. That is not a balance (Alpha
Retail: 135K → 7K). The console button now runs the same ledger rebuild as
the CLI, with an index (migration 0073) for speed.

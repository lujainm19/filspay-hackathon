-- R6 fix: the settlement summary and reconciliation queries were slow
-- (3–6 s for Delta Wholesale, docs/perf/2026-07-settlement-summary-slow.md).
--
-- Why: both look for capture events of one merchant inside a date window.
-- With no index on (event_type, occurred_at), Postgres read the whole
-- transaction_events table (400k rows) every time — the "Seq Scan" in the
-- perf doc. The doc's own follow-up ("try an index if it gets slow again")
-- was never done; raising shared_buffers only hid it.
--
-- This index lets those queries jump straight to the capture events in the
-- window, and INCLUDE carries the two columns they read so the table itself
-- is barely touched.

CREATE INDEX IF NOT EXISTS idx_transaction_events_type_occurred
    ON transaction_events (event_type, occurred_at)
    INCLUDE (transaction_id, amount_fils);

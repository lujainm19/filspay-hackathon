-- Integrity fixes found during the handover review. Each block names the
-- finding it fixes (see docs/FINDINGS.md).

-- A1: a pending (password-only, pre-OTP) session must never be "live".
-- live_sessions is what lookupSession() reads; without this filter the
-- session cookie issued after the password step authenticated every
-- merchant route before the OTP was ever entered.
CREATE OR REPLACE VIEW live_sessions AS
SELECT id,
       merchant_user_id,
       token_hash,
       authenticated,
       created_at,
       expires_at
  FROM sessions
 WHERE revoked_at IS NULL
   AND authenticated = true
   AND expires_at > now();

-- M6: platform-wide processed volume overflowed INTEGER (max 2,147,483,647
-- fils ≈ 2.1M BD) just above the 2,000,000,000 tier threshold.
ALTER TABLE platform_stats ALTER COLUMN total_processed_fils TYPE BIGINT;

-- M5: monitoring estimate was REAL (float32): ~7 significant digits, so a
-- high-volume merchant's lifetime total drifted. Money is integer fils.
ALTER TABLE merchants
  ALTER COLUMN lifetime_net_payout_monitoring_estimate TYPE BIGINT
  USING round(lifetime_net_payout_monitoring_estimate)::bigint;

-- S5 / incident 2026-08-21: duplicate settlement.paid. The NOT EXISTS
-- check-then-insert in EnqueuePayoutNotifications races between the daemon
-- and a CLI run. Keep the earliest row per batch, then make it impossible.
DELETE FROM outbox_events oe
 USING outbox_events dup
 WHERE oe.event_type = 'settlement.paid'
   AND dup.event_type = 'settlement.paid'
   AND oe.aggregate_id = dup.aggregate_id
   AND oe.id > dup.id
   AND NOT EXISTS (SELECT 1 FROM webhook_deliveries wd WHERE wd.outbox_event_id = oe.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_outbox_settlement_paid_once
    ON outbox_events (aggregate_id)
 WHERE event_type = 'settlement.paid';

-- S5 / incident 2026-08-21: a disbursement is a fact about a batch, not about
-- a webhook attempt. One per batch.
DELETE FROM settlement_payout_disbursements d
 USING settlement_payout_disbursements keep
 WHERE d.settlement_batch_id = keep.settlement_batch_id
   AND (d.created_at, d.id) > (keep.created_at, keep.id);
CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id);

-- FP-201: the postmortem says callbacks were deduplicated in May. They never
-- were: there is no processed_events table and no unique key. A redelivered
-- callback is now a no-op.
DELETE FROM acquirer_callback_notes n
 USING acquirer_callback_notes keep
 WHERE n.callback_id = keep.callback_id
   AND n.transaction_id = keep.transaction_id
   AND (n.created_at, n.id) > (keep.created_at, keep.id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acquirer_callback_notes_callback
    ON acquirer_callback_notes (callback_id, transaction_id);

-- Incident 2026-05-14: a reservation could be re-claimed after 60 s while
-- the first payer's capture was still running. Each claim now carries its
-- own id, and once capture starts the link can no longer be re-claimed.
ALTER TABLE payment_links
  ADD COLUMN IF NOT EXISTS reservation_id UUID,
  ADD COLUMN IF NOT EXISTS capture_started_at TIMESTAMPTZ;

-- Finance memo / Slack 2026-09-04: the same adjustment file was imported
-- twice. Imports are now keyed by a hash of their content.
ALTER TABLE adjustment_imports ADD COLUMN IF NOT EXISTS content_sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_adjustment_imports_content
    ON adjustment_imports (content_sha256)
 WHERE content_sha256 IS NOT NULL;

-- Reporting consumer read outbox rows by id, but ids are handed out at
-- INSERT time and committed in any order: a slow transaction's row could
-- commit *behind* the watermark and be skipped forever. The consumer now
-- only reads rows whose writing transaction is older than every in-flight
-- one (pg_snapshot_xmin).
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS created_xid xid8 NOT NULL DEFAULT pg_current_xact_id();

-- Poison events no longer stall the reporting worker forever.
CREATE TABLE IF NOT EXISTS reporting_dead_letters (
    outbox_event_id BIGINT PRIMARY KEY REFERENCES outbox_events (id) ON DELETE CASCADE,
    consumer_name   TEXT NOT NULL,
    error           TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- B5: refund summary joined refunds.id to transactions.id (never equal) and
-- summed captured_fils once per refund.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;
CREATE MATERIALIZED VIEW refund_merchant_summary AS
SELECT r.merchant_id,
       (r.occurred_at AT TIME ZONE 'Asia/Bahrain')::date AS business_date,
       COUNT(*)                 AS refund_count,
       SUM(r.amount_fils)       AS total_refunded_fils,
       SUM(r.fee_reversed_fils) AS total_fee_reversed_fils
  FROM refunds r
 WHERE r.status = 'succeeded'
 GROUP BY r.merchant_id, (r.occurred_at AT TIME ZONE 'Asia/Bahrain')::date;
CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);

-- Performance: the settlement summary and batch close join
-- transaction_events by transaction; the balance rebuild walks
-- merchant_payable per merchant.
CREATE INDEX IF NOT EXISTS idx_transaction_events_txn_type
    ON transaction_events (transaction_id, event_type);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_merchant_account
    ON ledger_entries (merchant_id, account_id) INCLUDE (direction, amount_fils);

-- Reporting cursor also remembers the last transaction id (xid8) it
-- processed, so it can walk the outbox in commit-safe order.
ALTER TABLE reporting_outbox_cursor ADD COLUMN IF NOT EXISTS last_processed_xid xid8;

-- Crash recovery for payment links: remember which authorization a
-- capture-in-progress belongs to, so a link left mid-capture by a crash can
-- be resolved (finalized if the capture committed, voided otherwise).
ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS pending_transaction_id UUID REFERENCES transactions (id);

-- FP-300 (reporting side): refund.succeeded events are now consumed by the
-- reporting worker into the same per-merchant Bahrain-day rollup as
-- captures and voids, so dashboards show refunds and net volume.
ALTER TABLE merchant_daily_volume
    ADD COLUMN IF NOT EXISTS refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

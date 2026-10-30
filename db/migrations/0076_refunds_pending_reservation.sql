-- C2 (FP-209), team decision "option B" (docs/PARTNER_FIXES.md §3): a refund
-- now reserves its amount first, calls the acquirer with no database lock
-- held, then settles.
--
-- Why the change: the first fix held a FOR UPDATE row lock (and a pool
-- connection) on the transaction for the whole acquirer call. Safe, but a
-- slow acquirer then ties up connections the checkout needs.
--
-- How the reservation works: the refund row is written as 'pending' while
-- the transaction row is locked, and the refundable amount is
--   captured − refunded − (pending refunds)
-- so a second refund can't use the same money while the first is still at
-- the acquirer. Every reader of refunds (settlement batch close, the
-- reconciliation query, refund_merchant_summary, the fee-reversal sum)
-- already filters on status = 'succeeded', so a pending row moves no money.

ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
ALTER TABLE refunds
  ADD CONSTRAINT refunds_status_check CHECK (status IN ('pending', 'succeeded', 'failed'));

-- A pending refund has no acquirer reference yet (and a failed one may never
-- get one). A succeeded refund must still have one.
ALTER TABLE refunds ALTER COLUMN acquirer_reference DROP NOT NULL;
ALTER TABLE refunds
  ADD CONSTRAINT chk_refunds_succeeded_has_reference
  CHECK (status <> 'succeeded' OR acquirer_reference IS NOT NULL);

-- What crash recovery needs to finish a refund left pending: the
-- idempotency claim to complete, and the exact key we sent the acquirer, so
-- asking again returns the same answer instead of refunding twice.
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS idempotency_key_id UUID REFERENCES idempotency_keys (id),
  ADD COLUMN IF NOT EXISTS acquirer_idempotency_key TEXT;

-- Reservation lookups ("how much is pending on this transaction") and the
-- recovery sweep only ever look at pending rows.
CREATE INDEX IF NOT EXISTS idx_refunds_pending
    ON refunds (transaction_id, created_at)
 WHERE status = 'pending';

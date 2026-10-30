-- C5 fix (FP-201, reopened): the same acquirer callback must only be saved once.
--
-- What was wrong: the 1.9.0 postmortem says callbacks are deduplicated through
-- a `processed_events` table. That table was never created and there was no
-- unique index here, so when the acquirer re-sent a callback we stored a
-- second identical note on the same payment.
--
-- Why (transaction_id, callback_id) and not callback_id alone: the sandbox
-- has been seen re-using callback ids across different transactions, and
-- those are genuinely different callbacks we must keep.
--
-- Existing exact duplicates are removed first (keeping the earliest copy),
-- otherwise the unique index can't be created on a database that already
-- has them.

DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.transaction_id = b.transaction_id
   AND a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX idx_acquirer_callback_notes_txn_callback
    ON acquirer_callback_notes (transaction_id, callback_id);

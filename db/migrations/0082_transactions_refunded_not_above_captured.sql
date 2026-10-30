-- FP-300 / M14 / C2 safety net: a transaction can never have more refunded
-- than was captured.
--
-- The application now enforces this (captured − refunded is the limit, under a
-- row lock), but the old code could refund more than was captured (M14) or
-- lose an update between two concurrent refunds (C2). With this CHECK the
-- database itself refuses any future write that would do that.
--
-- NOT VALID: existing rows aren't re-checked, so this can't fail on a
-- database that already holds bad history from the old code; every new
-- INSERT/UPDATE is checked. Finance can find old offenders with
-- SELECT id FROM transactions WHERE refunded_fils > captured_fils;

ALTER TABLE transactions
    ADD CONSTRAINT transactions_refunded_not_above_captured
    CHECK (refunded_fils <= captured_fils) NOT VALID;

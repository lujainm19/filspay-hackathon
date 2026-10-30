package settlement

import (
	"context"
	"testing"
	"time"
)

// M5 / ADR-0002: the 0-9 fils the scheme file drops are journaled to
// scheme_rounding_residue in the same close, so finance never needs a sweep.
func TestCloseBatch_JournalsSchemeRoundingResidue(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 21, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 4747, start.Add(time.Hour)) // scheme gets 4740

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	var residue, net int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'scheme_rounding_residue' AND direction = 'debit'), 0),
		       COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_fils ELSE -amount_fils END), 0)
		  FROM ledger_entries WHERE settlement_batch_id = $1 AND description = 'scheme rounding residue'`,
		closed.BatchID).Scan(&residue, &net); err != nil {
		t.Fatalf("read residue: %v", err)
	}
	if residue != 7 {
		t.Errorf("scheme_rounding_residue debited %d fils, want 7 (4747 - 4740)", residue)
	}
	if net != 0 {
		t.Errorf("residue entries don't balance: net %d", net)
	}
}

// T2: "MDR recalculation changed batches that were already paid out. Those
// should never change." A paid batch's row stays exactly as paid.
func TestRecalculateMDR_LeavesPaidBatchUnchanged(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 3, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertCaptureEvent(t, pool, merchantID, mdrBps, 10000, start.Add(time.Hour))

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("update mdr: %v", err)
	}
	from, to := recalcWindow(businessDate)
	if _, err := RecalculateMDR(ctx, pool, merchantID, from, to); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	var fee, net int64
	var status string
	if err := pool.QueryRow(ctx, `SELECT status, fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`,
		closed.BatchID).Scan(&status, &fee, &net); err != nil {
		t.Fatalf("read batch: %v", err)
	}
	if status != "paid" || fee != int64(closed.FeeFils) || net != int64(closed.NetPayoutFils) {
		t.Errorf("paid batch changed: status=%s fee=%d (was %d) net=%d (was %d)", status, fee, closed.FeeFils, net, closed.NetPayoutFils)
	}
}

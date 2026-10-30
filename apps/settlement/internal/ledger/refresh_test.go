package ledger

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func insertClosedBatchWithLine(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, batchDate string, amountFils int64, lineSequence int) uuid.UUID {
	t.Helper()
	ctx := context.Background()

	var batchID uuid.UUID
	err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at)
		VALUES ($1, $2, 'closed', $3, 0, $3, now())
		RETURNING id
	`, merchantID, batchDate, amountFils).Scan(&batchID)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert batch: %v", err)
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO scheme_export_lines (settlement_batch_id, amount_fils, line_sequence)
		VALUES ($1, $2, $3)
	`, batchID, amountFils, lineSequence)
	if err != nil {
		t.Fatalf("insertClosedBatchWithLine: insert export line: %v", err)
	}

	return batchID
}

// insertPayableCredit posts a balanced capture-style group: the merchant is
// owed amountFils.
func insertPayableCredit(t *testing.T, pool *pgxpool.Pool, merchantID uuid.UUID, amountFils int64) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		INSERT INTO ledger_entries (entry_group_id, merchant_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES ($1, $2, 'card_scheme_clearing', 'debit',  $3, now(), 'test capture'),
		       ($1, $2, 'merchant_payable',     'credit', $3, now(), 'test capture')
	`, uuid.New(), merchantID, amountFils)
	if err != nil {
		t.Fatalf("insertPayableCredit: %v", err)
	}
}

// Updated (hackathon review, FP-203): the console's "Rebuild cached balances"
// must give the same figure as the CLI, i.e. the merchant_payable ledger
// balance. These tests used to assert it equals the sum of scheme export
// lines — the bug that turned Alpha Retail's 135K into 7K.
func TestRefreshBalanceCache_OverwritesDriftedCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertPayableCredit(t, pool, merchantID, 25000)
	want := int64(25000)

	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 888888, now())
	`, merchantID)
	if err != nil {
		t.Fatalf("seed drifted cache: %v", err)
	}

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if diff.CachedBefore != 888888 {
		t.Errorf("diff.CachedBefore = %d, want 888888", diff.CachedBefore)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
	if !diff.Changed() {
		t.Error("diff.Changed() = false, want true")
	}

	var persisted int64
	err = pool.QueryRow(context.Background(), `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != want {
		t.Errorf("persisted cached_payable_fils = %d, want %d", persisted, want)
	}
}

func TestRefreshBalanceCache_SumsAcrossBatches(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertPayableCredit(t, pool, merchantID, 15000)
	insertPayableCredit(t, pool, merchantID, 6000)

	want := int64(15000 + 6000)

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}

	diff, ok := diffs[merchantID]
	if !ok {
		t.Fatalf("RefreshBalanceCache did not return a diff for merchant %s", merchantID)
	}
	if int64(diff.Rebuilt) != want {
		t.Errorf("diff.Rebuilt = %d, want %d", diff.Rebuilt, want)
	}
}

// FP-203 regression: scheme export lines are not a balance. A merchant with
// 135,000 fils owed in the ledger and only 7,000 fils of exported lines must
// rebuild to 135,000.
func TestRefreshBalanceCache_FollowsLedgerNotSchemeLines(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)

	insertPayableCredit(t, pool, merchantID, 135000)
	insertClosedBatchWithLine(t, pool, merchantID, "2026-06-13", 7000, 1)

	diffs, err := RefreshBalanceCache(context.Background(), pool)
	if err != nil {
		t.Fatalf("RefreshBalanceCache: %v", err)
	}
	cli, err := RebuildMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if diffs[merchantID].Rebuilt != 135000 || cli != 135000 {
		t.Fatalf("button=%d cli=%d, want both 135000", diffs[merchantID].Rebuilt, cli)
	}
}

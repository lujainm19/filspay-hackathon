package ledger

import (
	"context"
	"testing"
)

// `rebuild-balances --merchant=<id>` must actually fix that merchant's cache.
func TestRebuildAndStoreMerchantBalance_WritesTheCache(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool)
	postLedgerLeg(t, pool, merchantID, "credit", 10000)
	postLedgerLeg(t, pool, merchantID, "debit", 250)

	// A wrong cached value, like the 7K Alpha Retail was left with.
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at) VALUES ($1, 7, now())
		ON CONFLICT (merchant_id) DO UPDATE SET cached_payable_fils = 7`, merchantID); err != nil {
		t.Fatalf("seed cache: %v", err)
	}

	got, err := RebuildAndStoreMerchantBalance(context.Background(), pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildAndStoreMerchantBalance: %v", err)
	}
	if got != 9750 {
		t.Fatalf("returned %d, want 9750", got)
	}
	var cached int64
	if err := pool.QueryRow(context.Background(),
		`SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&cached); err != nil {
		t.Fatalf("read cache: %v", err)
	}
	if cached != 9750 {
		t.Errorf("cached_payable_fils = %d, want 9750 (the cache was not written)", cached)
	}
}

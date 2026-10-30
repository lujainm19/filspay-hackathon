package ledger

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RefreshBalanceCache backs the admin console's "Rebuild cached balances".
//
// FP-203: it used to rebuild from the merchant_payable_position view, which
// is the sum of *scheme export lines* — gross captures that were batched,
// with fees, payouts, refunds, credits and adjustments all ignored. That is
// not a balance. Alpha Retail went from 135K to 7K on a click while the CLI
// (which walks ledger_entries) gave the right figure. ADR-0004 called this a
// "faster query path"; the handover says there must not be a button that
// reads anything other than the ledger. It now runs exactly the CLI rebuild
// (with idx_ledger_entries_merchant_account from migration 0073 for speed).
func RefreshBalanceCache(ctx context.Context, db *pgxpool.Pool) (map[uuid.UUID]RebuildDiff, error) {
	return RebuildAllBalances(ctx, db)
}

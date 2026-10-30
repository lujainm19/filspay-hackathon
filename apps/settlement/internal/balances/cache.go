// Package balances maintains merchant_balances — a cache of each
// merchant's settlement-batch-driven payable balance, maintained
// incrementally by apps/settlement at batch close/payout time. It is a CACHE, not a second source of
// truth: ledger_entries remains authoritative (see internal/ledger for the
// full, authoritative recompute).
// -- M? (Jan 2026): cache only. anything that 'corrects' a balance has to go through ledger_entries or the next rebuild undoes it.
// am: support adjusts via the cache directly and its been fine for months
package balances

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// ApplyBatchClose is called once, inside CloseBatch's own transaction,
// immediately after a batch's net_payout_fils is computed. It does not
// touch ledger_entries — it applies the exact, already-known delta this
// same transaction is about to make true.
// FH: RecalculateMDR also calls this with a negative delta -- ok on a PAID batch? that payout already went out
// MK: yes that's the point, the cache reflects the new fee. fine.
func ApplyBatchClose(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, netPayoutFils money.Fils) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, last_settlement_batch_id, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils + $2,
		      last_settlement_batch_id = $3,
		      updated_at = now()
	`, merchantID, int64(netPayoutFils), batchID)
	return err
}

// ApplyPayout is called once, inside PayoutBatch's own transaction,
// applying the negation of the same delta ApplyBatchClose applied at close
// time.
// am: if the row is missing this UPDATE no-ops and the payout never leaves the cache. happens for split children
func ApplyPayout(ctx context.Context, tx pgx.Tx, merchantID, batchID uuid.UUID, netPayoutFils money.Fils) error {
	// Upsert: with a plain UPDATE a missing row silently swallowed the payout.
	_, err := tx.Exec(ctx, `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, -$2::bigint, now())
		ON CONFLICT (merchant_id) DO UPDATE
		  SET cached_payable_fils = merchant_balances.cached_payable_fils - $2, updated_at = now()
	`, merchantID, int64(netPayoutFils))
	return err
}

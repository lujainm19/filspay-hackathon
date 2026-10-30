package settlement

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// UpdateLifetimePayoutMonitoringEstimate maintains the ops dashboard
// running payout total on the merchant row. Not payout-affecting.
//
// Finance memo: "lifetime payout estimate drifts for high-volume merchants".
// It was accumulated as float32 into a REAL column (7 significant digits).
// The column is BIGINT now (migration 0073) and the addition is integer.
func UpdateLifetimePayoutMonitoringEstimate(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID, netPayoutFils money.Fils) error {
	_, err := tx.Exec(ctx, `
		UPDATE merchants
		   SET lifetime_net_payout_monitoring_estimate = lifetime_net_payout_monitoring_estimate + $2
		 WHERE id = $1
	`, merchantID, int64(netPayoutFils))
	return err
}

// EstimateMonthlyPayout returns the total payout for the merchant over the
// last 30 calendar days (integer fils).
func EstimateMonthlyPayout(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID) (money.Fils, error) {
	var total int64
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(SUM(net_payout_fils), 0) FROM settlement_batches
		 WHERE merchant_id = $1 AND status = 'paid' AND paid_at >= now() - interval '30 days'
	`, merchantID).Scan(&total)
	return money.Fils(total), err
}

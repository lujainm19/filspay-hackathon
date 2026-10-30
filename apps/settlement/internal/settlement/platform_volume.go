package settlement

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// ReadAndLockPlatformProcessedFils reads the platform-wide lifetime
// processed-volume counter with a row lock, so two batches closing
// concurrently serialize on this single shared counter row.
//
// int64: the counter was INTEGER/int32, and int32 addition in Go wraps
// silently — past 2,147,483,647 fils (≈2.1M BD, just above the tier
// threshold) the counter would have gone negative. Column is BIGINT (0073).
func ReadAndLockPlatformProcessedFils(ctx context.Context, tx pgx.Tx) (int64, error) {
	var current int64
	err := tx.QueryRow(ctx, `
		SELECT total_processed_fils FROM platform_stats WHERE id = 1 FOR UPDATE
	`).Scan(&current)
	return current, err
}

// RecordPlatformProcessedVolume adds this batch's gross fils to the
// already-locked running total and writes the result back.
func RecordPlatformProcessedVolume(ctx context.Context, tx pgx.Tx, current int64, batchGrossFils int64) error {
	_, err := tx.Exec(ctx, `
		UPDATE platform_stats SET total_processed_fils = $1, updated_at = now() WHERE id = 1
	`, current+batchGrossFils)
	return err
}

// VolumeTierMdrBonusBps returns the platform-wide MDR bonus (in bps) at a
// given processed volume. int64 throughout so the counter cannot wrap.
func VolumeTierMdrBonusBps(totalProcessedFils int64) int64 {
	const volumeTierThresholdFils int64 = 2_000_000_000 // 2,000,000.000 BD
	const volumeTierBonusBps int64 = 15                 // 0.15%
	if totalProcessedFils >= volumeTierThresholdFils {
		return volumeTierBonusBps
	}
	return 0
}

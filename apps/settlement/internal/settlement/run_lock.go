package settlement

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DailyRunLockKey is the pg advisory-lock key that serialises every path
// that runs the daily close / payout / notification pass: the daemon, the
// `run-batch` CLI and the internal API's run-batch endpoint (T4).
const DailyRunLockKey int64 = 0x46505F4441494C59 // "FP_DAILY"

// ErrDailyRunBusy is returned when another runner already holds the lock.
var ErrDailyRunBusy = errors.New("settlement: another daily run is in progress")

// WithDailyRunLock runs fn while holding a session-level advisory lock on a
// dedicated pooled connection. It never waits: if another runner holds the
// lock it returns ErrDailyRunBusy immediately. The lock is released on the
// same connection before it goes back to the pool (and Postgres drops it
// anyway if the connection dies), so a crashed runner never wedges it.
func WithDailyRunLock(ctx context.Context, db *pgxpool.Pool, fn func() error) error {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("settlement: daily-run lock: acquire: %w", err)
	}
	defer conn.Release()
	var locked bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, DailyRunLockKey).Scan(&locked); err != nil {
		return fmt.Errorf("settlement: daily-run lock: %w", err)
	}
	if !locked {
		return ErrDailyRunBusy
	}
	defer func() {
		if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, DailyRunLockKey); err != nil {
			log.Printf("settlement: daily-run unlock: %v", err)
		}
	}()
	return fn()
}

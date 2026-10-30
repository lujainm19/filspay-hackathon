package settlement

import (
	"context"
	"errors"
	"testing"
	"time"
)

// T2: a batch whose events were priced by a fee schedule row in force at the
// time must not be "corrected" to merchants.mdr_bps by RecalculateMDR.
func TestRecalculateMDR_UsesScheduleInForceAtEventTime(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	businessDate := time.Date(2026, 4, 9, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)
	insertFeeSchedule(t, pool, merchantID, 200, start.Add(-24*time.Hour))
	insertCaptureEvent(t, pool, merchantID, 200, 4750, start.Add(time.Hour))
	if _, err := CloseBatch(ctx, pool, merchantID, businessDate); err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatal(err)
	}
	from, to := recalcWindow(businessDate)
	res, err := RecalculateMDR(ctx, pool, merchantID, from, to)
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}
	if len(res.Adjusted) != 0 {
		t.Fatalf("batch priced by the schedule in force was re-priced: %+v", res.Adjusted)
	}
}

// Same effective_from twice: the most recently created row wins (matches
// apps/api's ORDER BY effective_from DESC, created_at DESC).
func TestEffectiveMdr_TieBreakNewestCreatedWins(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	eff := time.Date(2026, 3, 1, 0, 0, 0, 0, time.UTC)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO fee_schedules (merchant_id, mdr_bps, effective_from, created_at)
		VALUES ($1, 180, $2, now()), ($1, 220, $2, now() - interval '1 day')`, merchantID, eff); err != nil {
		t.Fatal(err)
	}
	got := EffectiveMdrBpsAt(loadSchedules(t, pool, merchantID), eff.Add(time.Hour), 250)
	if got != 180 {
		t.Fatalf("rate = %d, want 180 (newest created row)", got)
	}
}

// T4: a second runner never runs while the first holds the daily-run lock.
func TestWithDailyRunLock_SecondRunnerSkips(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	inner := errors.New("unset")
	err := WithDailyRunLock(ctx, pool, func() error {
		inner = WithDailyRunLock(ctx, pool, func() error { return nil })
		return nil
	})
	if err != nil {
		t.Fatalf("outer: %v", err)
	}
	if !errors.Is(inner, ErrDailyRunBusy) {
		t.Fatalf("inner = %v, want ErrDailyRunBusy", inner)
	}
	if err := WithDailyRunLock(ctx, pool, func() error { return nil }); err != nil {
		t.Fatalf("lock not released: %v", err)
	}
}

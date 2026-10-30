// Package scheduler — status.go. Log-only: tells an operator tailing the
// daemon's logs when the next daily close is due. runIfDue does not use it.
package scheduler

import (
	"log"
	"time"

	"github.com/filspay/settlement/internal/settlement"
)

// bahrain is only for printing; the close itself is decided by
// settlement.BusinessDayWindow.
var bahrain = mustLoad("Asia/Bahrain")

func mustLoad(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.FixedZone("Asia/Bahrain", 3*60*60)
	}
	return loc
}

// nextCloseAt is when runIfDue will next run a new business day: the next
// Bahrain midnight plus the run delay.
//
// This used to print "last check-in + 24h" in the server's own zone (UTC in
// the container), so a daemon started at 15:56 logged "next check-in
// 15:56 tomorrow" — which is not when the close runs (it polls every minute
// and closes just after Bahrain midnight) and fed the "the daily close
// timing doesn't match the docs" confusion.
func nextCloseAt(now time.Time, runDelayMinutes int) time.Time {
	delay := time.Duration(runDelayMinutes) * time.Minute
	todayStart, todayEnd := settlement.BusinessDayWindow(settlement.BahrainToday(now))
	if due := todayStart.Add(delay); now.Before(due) {
		return due.In(bahrain)
	}
	return todayEnd.Add(delay).In(bahrain)
}

// logNextRunEstimate writes the next close time to the daemon's log.
func logNextRunEstimate(now time.Time, runDelayMinutes int) {
	log.Printf("settlement daemon: next daily close at %s (Asia/Bahrain)", nextCloseAt(now, runDelayMinutes).Format(time.RFC3339))
}

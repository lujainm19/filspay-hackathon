package scheduler

import (
	"testing"
	"time"
)

// The log line must show when the close really runs: Bahrain midnight plus
// the run delay. It used to print "last check-in + 24h" in UTC.
func TestNextCloseAt(t *testing.T) {
	bh := time.FixedZone("BH", 3*60*60)
	cases := []struct {
		now  time.Time
		want time.Time
	}{
		// 15:56 Bahrain: today's close already ran, next is tomorrow 00:15.
		{time.Date(2026, 10, 30, 15, 56, 0, 0, bh), time.Date(2026, 10, 31, 0, 15, 0, 0, bh)},
		// 00:05 Bahrain: today's close is still 10 minutes away.
		{time.Date(2026, 10, 31, 0, 5, 0, 0, bh), time.Date(2026, 10, 31, 0, 15, 0, 0, bh)},
		// 22:30 UTC = 01:30 Bahrain next day: the close for that day already ran.
		{time.Date(2026, 10, 30, 22, 30, 0, 0, time.UTC), time.Date(2026, 11, 1, 0, 15, 0, 0, bh)},
	}
	for _, c := range cases {
		if got := nextCloseAt(c.now, 15); !got.Equal(c.want) {
			t.Errorf("nextCloseAt(%s) = %s, want %s", c.now.Format(time.RFC3339), got.Format(time.RFC3339), c.want.Format(time.RFC3339))
		}
	}
}

package settlement

import (
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

// Regression tests for the handover review fixes (docs/FINDINGS.md).

// M4: float32 lost fils on any batch above ~16,777 BD.
func TestNetPayableFils_ExactForLargeBatches(t *testing.T) {
	cases := []struct{ gross, fee, want money.Fils }{
		{20_000_123, 550_003, 19_450_120}, // Delta Wholesale-sized day
		{16_777_217, 0, 16_777_217},       // first value float32 cannot represent
		{999_999_999_999, 1, 999_999_999_998},
	}
	for _, c := range cases {
		if got := NetPayableFils(c.gross, c.fee); got != c.want {
			t.Errorf("NetPayableFils(%d, %d) = %d, want %d", c.gross, c.fee, got, c.want)
		}
	}
}

// M7: the scheme amount is the TRUNCATED figure, never rounded up.
func TestSchemeAmountBD_TruncatesNeverRoundsUp(t *testing.T) {
	cases := map[money.Fils]string{
		93_275: "93.27", // the Slack example: was written as 93.28
		93_270: "93.27",
		4_749:  "4.74",
		5:      "0.00",
		1_000:  "1.00",
	}
	for in, want := range cases {
		if got := SchemeAmountBD(in); got != want {
			t.Errorf("SchemeAmountBD(%d) = %q, want %q", in, got, want)
		}
	}
}

// S1: the daemon's notion of "today" is Bahrain's date, not the UTC date.
func TestBahrainToday_EarlyMorningIsBahrainDate(t *testing.T) {
	// 00:20 Bahrain on 15 May = 21:20 UTC on 14 May.
	now := time.Date(2026, 5, 14, 21, 20, 0, 0, time.UTC)
	got := BahrainToday(now)
	if want := time.Date(2026, 5, 15, 0, 0, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("BahrainToday(%s) = %s, want %s", now, got, want)
	}
	start, _ := BusinessDayWindow(got)
	if want := time.Date(2026, 5, 14, 21, 0, 0, 0, time.UTC); !start.Equal(want) {
		t.Fatalf("today's window start = %s, want %s (Bahrain midnight)", start.UTC(), want)
	}
}

// Tier counter is int64: 3,000,000 BD must not wrap negative.
func TestVolumeTierMdrBonusBps_Int64NoWrap(t *testing.T) {
	if got := VolumeTierMdrBonusBps(3_000_000_000); got != 15 {
		t.Fatalf("VolumeTierMdrBonusBps(3e9) = %d, want 15 (int32 would have wrapped negative)", got)
	}
}

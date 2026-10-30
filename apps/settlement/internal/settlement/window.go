// Package settlement implements the daily per-merchant batching algorithm:
// eligible-event selection, MDR fee
// recomputation, scheme export line generation, and the payout ledger
// posting.
package settlement

import (
	"fmt"
	"time"
)

// businessDayLocation is the settlement business day's fixed timezone:
// Asia/Bahrain (UTC+3, no DST since 1972).
var businessDayLocation = mustLoadLocation("Asia/Bahrain")

func mustLoadLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic(fmt.Sprintf("settlement: failed to load timezone %q: %v", name, err))
	}
	return loc
}

// BusinessDate normalizes a business *date* (only its calendar Y/M/D, as
// given, matter) to the UTC-midnight form batch_date is stored in.
func BusinessDate(date time.Time) time.Time {
	y, m, d := date.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

// BahrainToday returns today's Asia/Bahrain calendar date for an instant.
//
// Finance memo: "the daily close is running at 3am local, not midnight".
// The daemon passed time.Now().UTC() straight into BusinessDayWindow, which
// reads the calendar date *as given* — the UTC date. Between 00:00 and 03:00
// Bahrain the UTC date is still yesterday, so "today's" start was a day
// early, the due check didn't fire, and the close only ran once the UTC date
// flipped (03:00 + 15 min delay = ~03:15 local). Converting the instant to
// Bahrain time first fixes it.
func BahrainToday(now time.Time) time.Time {
	return BusinessDate(now.In(businessDayLocation))
}

// BusinessDayWindow returns the [start, end) instants bounding the given
// business date's Asia/Bahrain day: Bahrain 00:00 on that date through
// Bahrain 00:00 the next day.
func BusinessDayWindow(date time.Time) (start, end time.Time) {
	bd := BusinessDate(date)
	start = time.Date(bd.Year(), bd.Month(), bd.Day(), 0, 0, 0, 0, businessDayLocation)
	end = start.AddDate(0, 0, 1)
	return start, end
}

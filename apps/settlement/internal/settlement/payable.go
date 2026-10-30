package settlement

import "github.com/filspay/settlement/internal/money"

// NetPayableFils derives the net payout from frozen gross and fee totals.
//
// Integer fils, always. This used to convert to float32 BD and back:
// float32 has ~7 significant digits, so any batch above ~16,777 BD
// (16,777,216 fils) lost fils — e.g. Delta Wholesale's 20,000.123 BD days.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}

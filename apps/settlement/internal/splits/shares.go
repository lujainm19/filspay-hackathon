package splits

import "github.com/filspay/settlement/internal/money"

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights using
// the largest-remainder method (the Go twin of packages/money's
// allocateRemainder): every share is floored, then the leftover fils go one
// at a time to the largest remainders (ties to the lower index).
//
// Finance memo: "the three child payouts don't add up to the parent's total.
// A few tens of fils each batch ... where do the missing fils go?" They went
// nowhere: rounding each child independently with ApplyRateFils simply
// dropped (or invented) fils, which then sat in the parent's payable.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	if len(children) == 0 || netPayout <= 0 {
		return out
	}
	var totalWeight int64
	for _, c := range children {
		totalWeight += c.WeightBps
	}
	if totalWeight <= 0 {
		return out
	}
	remainders := make([]int64, len(children))
	var allocated int64
	for i, c := range children {
		product := int64(netPayout) * c.WeightBps
		out[i] = money.Fils(product / totalWeight)
		remainders[i] = product % totalWeight
		allocated += int64(out[i])
	}
	leftover := int64(netPayout) - allocated
	for leftover > 0 {
		best := -1
		for i := range children {
			if best == -1 || remainders[i] > remainders[best] {
				best = i
			}
		}
		out[best]++
		remainders[best] = -1
		leftover--
	}
	return out
}

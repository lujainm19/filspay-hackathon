package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Finance memo: Delta Marketplace's child payouts never added up to the
// parent's total. Shares must always sum to the net, exactly.
func TestChildShares_AlwaysSumToNet(t *testing.T) {
	weights := [][]int64{
		{3333, 3333, 3334},
		{5000, 2500, 2500},
		{1, 1, 1},
		{7000, 3000},
	}
	for _, ws := range weights {
		children := make([]ChildWeight, len(ws))
		for i, w := range ws {
			children[i] = ChildWeight{WeightBps: w}
		}
		for net := money.Fils(1); net <= 100_003; net += 997 {
			var total money.Fils
			for _, s := range ChildShares(net, children) {
				if s < 0 {
					t.Fatalf("negative share for net %d", net)
				}
				total += s
			}
			if total != net {
				t.Fatalf("weights %v net %d: shares sum to %d", ws, net, total)
			}
		}
	}
}

package management

import "testing"

func TestNormalizeRoutingStrategyWeightedRoundRobin(t *testing.T) {
	for _, input := range []string{"weighted-round-robin", "weightedroundrobin", "wrr"} {
		got, ok := normalizeRoutingStrategy(input)
		if !ok || got != "weighted-round-robin" {
			t.Fatalf("normalizeRoutingStrategy(%q) = %q, %v; want weighted-round-robin, true", input, got, ok)
		}
	}
}

func TestNormalizeRoutingStrategySoonestResetFirst(t *testing.T) {
	for _, input := range []string{"soonest-reset-first", " Soonest-Reset-First ", "srf"} {
		if got, ok := normalizeRoutingStrategy(input); !ok || got != "soonest-reset-first" {
			t.Fatalf("normalizeRoutingStrategy(%q) = %q, %v", input, got, ok)
		}
	}
}

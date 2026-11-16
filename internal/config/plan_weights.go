package config

import (
	"fmt"
	"math"
	"strings"
)

const (
	// DefaultPlanHeadroomReserve is the routing.plan-headroom-reserve used when the key is
	// omitted: a Pro account (weight 1) counts as tight below 10% of its 5-hour window left,
	// a Max 20x account (weight 20) below 0.5%.
	DefaultPlanHeadroomReserve = 10.0
	// MaxPlanWeight bounds routing.plan-weights values.
	MaxPlanWeight = 1000.0
	// MaxPlanHeadroomReserve bounds routing.plan-headroom-reserve.
	MaxPlanHeadroomReserve = 1000.0
)

// NormalizePlanKey returns the canonical form of a provider or plan name used by
// routing.plan-weights: lower case, trimmed, with spaces and hyphens folded to
// underscores ("Max 20x" and "max-20x" both become "max_20x").
func NormalizePlanKey(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	name = strings.NewReplacer(" ", "_", "-", "_").Replace(name)
	for strings.Contains(name, "__") {
		name = strings.ReplaceAll(name, "__", "_")
	}
	return strings.Trim(name, "_")
}

// EffectivePlanHeadroomReserve returns routing.plan-headroom-reserve, or the default
// when it is omitted.
func (r RoutingConfig) EffectivePlanHeadroomReserve() float64 {
	if r.PlanHeadroomReserve == nil {
		return DefaultPlanHeadroomReserve
	}
	return *r.PlanHeadroomReserve
}

// ValidatePlanRouting validates routing.plan-weights and routing.plan-headroom-reserve.
func (cfg *Config) ValidatePlanRouting() error {
	if cfg == nil {
		return nil
	}
	seenProviders := make(map[string]string, len(cfg.Routing.PlanWeights))
	for provider, plans := range cfg.Routing.PlanWeights {
		normalizedProvider := NormalizePlanKey(provider)
		if normalizedProvider == "" {
			return fmt.Errorf("routing.plan-weights: provider name must not be empty")
		}
		if previous, dup := seenProviders[normalizedProvider]; dup {
			return fmt.Errorf("routing.plan-weights: providers %q and %q are the same provider", previous, provider)
		}
		seenProviders[normalizedProvider] = provider
		seenPlans := make(map[string]string, len(plans))
		for plan, weight := range plans {
			normalizedPlan := NormalizePlanKey(plan)
			if normalizedPlan == "" {
				return fmt.Errorf("routing.plan-weights.%s: plan name must not be empty", provider)
			}
			if previous, dup := seenPlans[normalizedPlan]; dup {
				return fmt.Errorf("routing.plan-weights.%s: plans %q and %q are the same plan", provider, previous, plan)
			}
			seenPlans[normalizedPlan] = plan
			if math.IsNaN(weight) || math.IsInf(weight, 0) || weight <= 0 || weight > MaxPlanWeight {
				return fmt.Errorf("routing.plan-weights.%s.%s: weight must be greater than 0 and at most %g", provider, plan, MaxPlanWeight)
			}
		}
	}
	if reserve := cfg.Routing.PlanHeadroomReserve; reserve != nil {
		if math.IsNaN(*reserve) || math.IsInf(*reserve, 0) || *reserve < 0 || *reserve > MaxPlanHeadroomReserve {
			return fmt.Errorf("routing.plan-headroom-reserve: must be between 0 and %g", MaxPlanHeadroomReserve)
		}
	}
	return nil
}

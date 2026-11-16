package auth

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	internalconfig "github.com/rune-oai/t3code-proxy/internal/config"
)

// Plan capacity.
//
// Accounts in one provider pool are not equal: a Claude Max 20x account has
// roughly twenty times the allowance of a Pro account. PlanWeight expresses an
// account's capacity relative to its provider's base paid plan (1.0) so routing
// can spread new conversations and judge headroom in proportion to capacity.

// defaultPlanWeights is the single table of built-in plan weights, keyed by
// provider and normalized plan name (see internalconfig.NormalizePlanKey).
// routing.plan-weights overrides any entry.
//
// Claude: Pro is the base plan; Max 5x and Max 20x are named after their
// multiple of Pro usage. "max" is a Max account whose tier is unknown and is
// counted as the smaller Max plan. Team seats are counted as Pro.
//
// Codex: the ratios are APPROXIMATE. OpenAI describes its tiers as multiples of
// Plus usage and changes them over time. Plus is the base plan; the $100 Pro
// tier (reported as "prolite") is 5x Plus and the $200 Pro tier ("pro") 20x.
// The $500 tier ("promax") is set to 2.5x Pro. Team/Business, Enterprise and Edu
// seats are counted as Plus. Override with routing.plan-weights.codex when the
// real ratio is known.
//
// xAI: SuperGrok is the base plan. SuperGrok Heavy carries ten times the
// monthly credit of SuperGrok.
var defaultPlanWeights = map[string]map[string]float64{
	"claude": {
		"pro":     1,
		"team":    1,
		"max":     5,
		"max_5x":  5,
		"max_20x": 20,
	},
	"codex": {
		"plus":       1,
		"team":       1,
		"business":   1,
		"enterprise": 1,
		"edu":        1,
		"prolite":    5,
		"pro":        20,
		"promax":     50,
	},
	"xai": {
		"supergrok":       1,
		"supergrok_heavy": 10,
	},
}

// planMultiplierPattern matches a plan or tier name that carries its own
// multiple of the base plan, such as "max_20x" or "default_claude_max_20x".
var planMultiplierPattern = regexp.MustCompile(`(?:^|_)(max_)?([0-9]+(?:\.[0-9]+)?)x$`)

// planRoutingSettings is the hot-reloaded routing.plan-weights and
// routing.plan-headroom-reserve state.
type planRoutingSettings struct {
	weights map[string]map[string]float64
	reserve float64
}

var planRouting atomic.Pointer[planRoutingSettings]

// applyPlanRoutingConfig publishes the plan routing settings of cfg. It runs on
// every manager config update, so the settings follow config hot reloads.
func applyPlanRoutingConfig(cfg *internalconfig.Config) {
	settings := &planRoutingSettings{reserve: internalconfig.DefaultPlanHeadroomReserve}
	if cfg != nil {
		settings.weights = NormalizePlanWeights(cfg.Routing.PlanWeights)
		settings.reserve = cfg.Routing.EffectivePlanHeadroomReserve()
	}
	planRouting.Store(settings)
}

func currentPlanRouting() *planRoutingSettings {
	if settings := planRouting.Load(); settings != nil {
		return settings
	}
	return &planRoutingSettings{reserve: internalconfig.DefaultPlanHeadroomReserve}
}

// planHeadroomReserve returns the active routing.plan-headroom-reserve.
func planHeadroomReserve() float64 {
	return currentPlanRouting().reserve
}

// NormalizePlanWeights returns a copy of a routing.plan-weights table with
// normalized provider and plan keys. Invalid weights are dropped; config
// validation rejects them before they reach the runtime.
func NormalizePlanWeights(weights map[string]map[string]float64) map[string]map[string]float64 {
	out := make(map[string]map[string]float64, len(weights))
	for provider, plans := range weights {
		provider = internalconfig.NormalizePlanKey(provider)
		if provider == "" {
			continue
		}
		for plan, weight := range plans {
			plan = internalconfig.NormalizePlanKey(plan)
			if plan == "" || !validPlanWeight(weight) {
				continue
			}
			if out[provider] == nil {
				out[provider] = make(map[string]float64)
			}
			out[provider][plan] = weight
		}
	}
	return out
}

func validPlanWeight(weight float64) bool {
	return !math.IsNaN(weight) && !math.IsInf(weight, 0) && weight > 0 && weight <= internalconfig.MaxPlanWeight
}

// DefaultPlanWeights returns a copy of the built-in plan weight table.
func DefaultPlanWeights() map[string]map[string]float64 {
	return NormalizePlanWeights(defaultPlanWeights)
}

// EffectivePlanWeights returns the built-in table with configured overrides
// applied on top. Plans whose weight is derived from an "<N>x" suffix are not
// listed; PlanWeight resolves them on demand.
func EffectivePlanWeights(configured map[string]map[string]float64) map[string]map[string]float64 {
	out := DefaultPlanWeights()
	for provider, plans := range NormalizePlanWeights(configured) {
		if out[provider] == nil {
			out[provider] = make(map[string]float64, len(plans))
		}
		for plan, weight := range plans {
			out[provider][plan] = weight
		}
	}
	return out
}

// PlanWeight returns the capacity of plan relative to provider's base paid plan
// (1.0), using routing.plan-weights overrides first, then the built-in table,
// then an "<N>x" multiplier in the plan name for providers with a built-in
// table. An unknown plan or provider weighs 1.
func PlanWeight(provider, plan string) float64 {
	provider = internalconfig.NormalizePlanKey(provider)
	plan = normalizePlan(plan)
	if provider == "" || plan == "" {
		return 1
	}
	if weight, ok := currentPlanRouting().weights[provider][plan]; ok {
		return weight
	}
	builtIn, known := defaultPlanWeights[provider]
	if !known {
		return 1
	}
	if weight, ok := builtIn[plan]; ok {
		return weight
	}
	if multiplier := planMultiplier(plan); multiplier > 0 {
		return multiplier
	}
	return 1
}

// PlanWeightOf returns PlanWeight for the account's provider and plan.
func PlanWeightOf(auth *Auth) float64 {
	if auth == nil {
		return 1
	}
	return PlanWeight(auth.Provider, PlanOf(auth))
}

func planMultiplier(plan string) float64 {
	match := planMultiplierPattern.FindStringSubmatch(plan)
	if match == nil {
		return 0
	}
	multiplier, errParse := strconv.ParseFloat(match[2], 64)
	if errParse != nil || !validPlanWeight(multiplier) {
		return 0
	}
	return multiplier
}

// normalizePlan returns the canonical plan name for a plan, subscription type
// or rate-limit tier value. Tier names that carry a Max multiplier collapse to
// "max_<N>x" ("default_claude_max_20x" becomes "max_20x").
func normalizePlan(raw string) string {
	plan := internalconfig.NormalizePlanKey(raw)
	if match := planMultiplierPattern.FindStringSubmatch(plan); match != nil && match[1] != "" {
		return "max_" + match[2] + "x"
	}
	return plan
}

// observedPlans holds plans learned at runtime (for example from the Claude
// OAuth profile the quota-history recorder fetches), keyed by auth ID.
var observedPlans sync.Map

// ObserveAuthPlan records the plan of an account learned from an upstream
// reading. An empty plan clears the recorded value. It takes precedence over
// plan fields stored with the credential, which can be stale.
func ObserveAuthPlan(authID, plan string) {
	authID = strings.TrimSpace(authID)
	if authID == "" {
		return
	}
	if plan = normalizePlan(plan); plan == "" {
		observedPlans.Delete(authID)
		return
	}
	observedPlans.Store(authID, plan)
}

// planFieldKeys are the credential attribute and metadata keys that carry a
// plan, in order of preference. A rate-limit tier counts only when it names a
// Max multiplier, because tiers such as "default_claude_ai" say nothing about
// the plan.
var planFieldKeys = []struct {
	key  string
	tier bool
}{
	{key: "plan_type"},
	{key: "plan"},
	{key: "rate_limit_tier", tier: true},
	{key: "rateLimitTier", tier: true},
	{key: "subscription_type"},
	{key: "subscriptionType"},
}

// PlanOf returns the account's normalized lower-case plan, such as "pro",
// "max_5x", "max_20x" (Claude) or "plus", "pro", "team" (Codex), or "" when
// unknown. Sources, newest first: a plan observed at runtime (ObserveAuthPlan),
// the X-Codex-Plan-Type response header, then the credential's attributes and
// metadata (Codex plan_type from the ID token, Claude subscription type or
// rate-limit tier).
func PlanOf(auth *Auth) string {
	if auth == nil {
		return ""
	}
	if value, ok := observedPlans.Load(auth.ID); ok {
		if plan, _ := value.(string); plan != "" {
			return plan
		}
	}
	if plan := codexPlanSignal(auth); plan != "" {
		return plan
	}
	for _, field := range planFieldKeys {
		raw := strings.TrimSpace(auth.Attributes[field.key])
		if raw == "" {
			raw, _ = auth.Metadata[field.key].(string)
		}
		plan := normalizePlan(raw)
		if plan == "" || (field.tier && !strings.HasPrefix(plan, "max_")) {
			continue
		}
		return plan
	}
	return ""
}

// codexPlanSignal returns the plan from the newest passive X-Codex-Plan-Type
// response header recorded for a Codex account.
func codexPlanSignal(auth *Auth) string {
	if !strings.EqualFold(strings.TrimSpace(auth.Provider), "codex") {
		return ""
	}
	const header = "X-Codex-Plan-Type"
	best := auth.Quota
	for _, state := range auth.ModelStates {
		if state == nil || state.Quota.Signals[header] == "" {
			continue
		}
		if best.Signals[header] == "" || state.Quota.ObservedAt.After(best.ObservedAt) {
			best = state.Quota
		}
	}
	return normalizePlan(best.Signals[header])
}

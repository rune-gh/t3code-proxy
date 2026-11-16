package management

import (
	"net/http"

	"github.com/gin-gonic/gin"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

// GetRoutingPlanWeights returns the plan capacity weights used by routing.
//
//	GET /v8/management/routing/plan-weights
//
// The response is {"defaults": {...}, "configured": {...}, "effective": {...}},
// each keyed by provider and then plan. "configured" is routing.plan-weights
// with normalized keys; "effective" is the defaults with it applied. Writes go
// through /v8/management/config/routing/plan-weights.
func (h *Handler) GetRoutingPlanWeights(c *gin.Context) {
	h.mu.Lock()
	var configured map[string]map[string]float64
	if h.cfg != nil {
		configured = coreauth.NormalizePlanWeights(h.cfg.Routing.PlanWeights)
	}
	h.mu.Unlock()
	if configured == nil {
		configured = map[string]map[string]float64{}
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{
		"defaults":   coreauth.DefaultPlanWeights(),
		"configured": configured,
		"effective":  coreauth.EffectivePlanWeights(configured),
	})
}

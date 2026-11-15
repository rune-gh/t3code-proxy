package cliproxy

import (
	"testing"

	internalconfig "github.com/rune-oai/t3code-proxy/internal/config"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func TestSoonestResetFirstRoutingSelector(t *testing.T) {
	state := normalizedRoutingRuntimeState(&internalconfig.Config{Routing: internalconfig.RoutingConfig{Strategy: "soonest-reset-first"}})
	if _, ok := newRoutingSelector(state).(*coreauth.SoonestResetFirstSelector); !ok {
		t.Fatalf("strategy %q selected %T", state.strategy, newRoutingSelector(state))
	}
	state.sessionAffinity = true
	if _, ok := newRoutingSelector(state).(*coreauth.SessionAffinitySelector); !ok {
		t.Fatal("session affinity not preserved")
	}
}

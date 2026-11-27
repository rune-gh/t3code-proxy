package cliproxy

import (
	"testing"
	"time"

	"github.com/rune-oai/t3code-proxy/internal/registry"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	"github.com/rune-oai/t3code-proxy/sdk/config"
)

// A standalone hub publishes the Antigravity catalog through
// applyAntigravityModelHints -> ReplaceClientModels, not
// registerResolvedModelsForAuthFenced. That path must keep the login reserved
// for the Antigravity CLI, or every client lists and routes its models.
func TestAntigravityRegistrationStampsReservedFor(t *testing.T) {
	resetAntigravityCapabilityCache()
	t.Cleanup(resetAntigravityCapabilityCache)
	manager := coreauth.NewManager(nil, nil, nil)
	svc := &Service{cfg: &config.Config{}, coreManager: manager}
	const model = "gemini-3.1-flash-lite"
	auth := antigravityTestAuth("reservation-leak", "http://127.0.0.1:1")
	if got := auth.ReservedClient(); got != registry.ReservedForAntigravityCLI {
		t.Fatalf("ReservedClient() = %q, want %q (Provider %q)", got, registry.ReservedForAntigravityCLI, auth.Provider)
	}
	auth, _ = manager.Register(t.Context(), auth)
	t.Cleanup(func() { GlobalModelRegistry().UnregisterClient(auth.ID) })

	// A live hub has a cached catalog after its first probe.
	key := svc.antigravityCapabilityKey(auth)
	hints := antigravityModelCapabilityHints{ModelIDs: map[string]struct{}{model: {}}, revision: 1}
	antigravityCapabilityMu.Lock()
	antigravityCapabilityCache[key] = antigravityCapabilityCacheEntry{hints: hints, probeRevision: 1, expiresAt: time.Now().Add(antigravityCapabilityCacheTTL)}
	antigravityCapabilityMu.Unlock()

	// Real Service registration path.
	svc.registerModelsForAuth(t.Context(), auth)
	svc.WaitAntigravityProbes()

	reg := registry.GetGlobalRegistry()
	infos := reg.GetModelsForClient(auth.ID)
	if len(infos) == 0 {
		t.Fatal("antigravity catalog not registered")
	}

	listed := func(name string, models []map[string]any) {
		for _, m := range models {
			if m["id"] == model || m["name"] == "models/"+model {
				t.Errorf("%s lists Antigravity model %s", name, model)
			}
		}
	}
	// curl /v1/models (no subscription client).
	listed("third-party /v1/models", reg.ClientModels("", "", "openai"))
	// curl /provider/antigravity/v1/models.
	listed("third-party /provider/antigravity/v1/models", reg.ClientModels("antigravity", "", "openai"))
	// Claude Code Anthropic-format /v1/models.
	listed("Claude Code /v1/models", reg.ClientModels("", registry.ReservedForClaudeCode, "claude"))
	// Request routing for a third-party client.
	if reserved := reg.ReservedElsewhere(model, "", ""); reserved != registry.ReservedForAntigravityCLI {
		t.Errorf("ReservedElsewhere(%s, third-party) = %q, want %q", model, reserved, registry.ReservedForAntigravityCLI)
	}
	// The Antigravity CLI must still see it.
	if len(reg.ClientModelInfos("antigravity", registry.ReservedForAntigravityCLI)) == 0 {
		t.Error("Antigravity CLI catalog is empty")
	}
}

package cliproxy

import (
	"context"
	"testing"

	internalconfig "github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	"github.com/rune-oai/t3code-proxy/sdk/config"
)

func newAdoptionTestService(t *testing.T, cfg *config.Config, auths ...*coreauth.Auth) *Service {
	t.Helper()
	service := &Service{cfg: cfg, coreManager: coreauth.NewManager(nil, nil, nil)}
	reg := registry.GetGlobalRegistry()
	for _, auth := range auths {
		if _, err := service.coreManager.Register(context.Background(), auth); err != nil {
			t.Fatalf("register auth %s: %v", auth.ID, err)
		}
		service.registerModelsForAuth(context.Background(), auth)
		authID := auth.ID
		t.Cleanup(func() { reg.UnregisterClient(authID) })
	}
	return service
}

func modelProviders(modelID string) map[string]bool {
	out := make(map[string]bool)
	for _, p := range registry.GetGlobalRegistry().GetModelProviders(modelID) {
		out[p] = true
	}
	return out
}

func oauthAuth(id, provider string, attrs ...string) *coreauth.Auth {
	attributes := map[string]string{"auth_kind": "oauth"}
	for i := 0; i+1 < len(attrs); i += 2 {
		attributes[attrs[i]] = attrs[i+1]
	}
	return &coreauth.Auth{ID: id, Provider: provider, Status: coreauth.StatusActive, Attributes: attributes}
}

func TestAdoptUnknownModelRoutesFamilyToProviderCredentials(t *testing.T) {
	claudeAuth := oauthAuth("adopt-claude", "claude")
	codexAuth := oauthAuth("adopt-codex", "codex", "plan_type", "pro")
	service := newAdoptionTestService(t, &config.Config{}, claudeAuth, codexAuth)
	reg := registry.GetGlobalRegistry()

	const claudeModel = "claude-adopttest-9-9"
	const codexModel = "gpt-adopttest-9.9-codex"
	if len(reg.GetModelProviders(claudeModel)) != 0 {
		t.Fatalf("%s must start unknown", claudeModel)
	}
	if !service.adoptUnknownModel(claudeModel, "") {
		t.Fatalf("adoptUnknownModel(%q) = false, want true", claudeModel)
	}
	if got := modelProviders(claudeModel); !got["claude"] || got["codex"] {
		t.Fatalf("providers for %s = %v, want only claude", claudeModel, got)
	}
	if !reg.ClientSupportsModel(claudeAuth.ID, claudeModel) {
		t.Fatalf("claude credential does not serve %s, so account selection would skip it", claudeModel)
	}
	info := reg.GetModelInfo(claudeModel, "claude")
	if info == nil || info.Thinking == nil || len(info.Thinking.Levels) == 0 {
		t.Fatalf("adopted model lost the family's thinking support: %+v", info)
	}

	if !service.adoptUnknownModel(codexModel, "") || !modelProviders(codexModel)["codex"] {
		t.Fatalf("codex model was not adopted: providers %v", modelProviders(codexModel))
	}

	// A later re-registration (catalog refresh, token refresh) keeps the model.
	service.registerModelsForAuth(context.Background(), claudeAuth)
	if !reg.ClientSupportsModel(claudeAuth.ID, claudeModel) {
		t.Fatalf("re-registration dropped adopted model %s", claudeModel)
	}

	// Context-window variants and long names are adopted too.
	for _, id := range []string{"claude-adopttest-9-9[1m]", "claude-adopttest-with-a-very-long-name-that-goes-well-past-sixty-four-characters"} {
		if !service.adoptUnknownModel(id, "") || !modelProviders(id)["claude"] {
			t.Errorf("%s was not adopted on claude", id)
		}
	}

	// Families without credentials, and names no provider owns, are refused.
	for _, id := range []string{"grok-adopttest-9", "notafamily-1"} {
		if service.adoptUnknownModel(id, "") {
			t.Errorf("adoptUnknownModel(%q) = true, want false", id)
		}
	}
}

func TestAdoptUnknownModelHasNoCap(t *testing.T) {
	auth := oauthAuth("adopt-claude-nocap", "claude")
	service := newAdoptionTestService(t, &config.Config{}, auth)
	for i := 0; i < 100; i++ {
		id := "claude-nocap-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		if !service.adoptUnknownModel(id, "") {
			t.Fatalf("model %d (%s) was not adopted", i, id)
		}
	}
}

func TestAdoptUnknownModelHonorsExcludedModels(t *testing.T) {
	auth := oauthAuth("adopt-claude-excluded", "claude")
	cfg := &config.Config{OAuthExcludedModels: map[string][]string{"claude": {"claude-blocked-*"}}}
	service := newAdoptionTestService(t, cfg, auth)
	reg := registry.GetGlobalRegistry()

	if service.adoptUnknownModel("claude-blocked-9", "") {
		t.Fatal("an excluded model must not be adopted")
	}
	if reg.ClientSupportsModel(auth.ID, "claude-blocked-9") {
		t.Fatal("excluded model was registered")
	}
	// A repeat request does not re-register the credential again.
	epoch := reg.ClientRegistrationEpoch(auth.ID)
	service.adoptUnknownModel("claude-blocked-9", "")
	if got := reg.ClientRegistrationEpoch(auth.ID); got != epoch {
		t.Fatalf("a repeat request re-registered the credential: epoch %d -> %d", epoch, got)
	}
}

// OpenAI-compatible upstreams (Mistral for OpenCode, a prefixed Vibe key) adopt
// by family, by provider scope and by credential prefix.
func TestAdoptUnknownModelCoversOpenAICompatibleUpstreams(t *testing.T) {
	cfg := &config.Config{
		SDKConfig: config.SDKConfig{ForceModelPrefix: true},
		OpenAICompatibility: []internalconfig.OpenAICompatibility{
			{Name: "mistral", BaseURL: "https://api.mistral.ai/v1", Models: []internalconfig.OpenAICompatibilityModel{{Name: "mistral-medium-3.5"}, {Name: "devstral-2"}}},
			{Name: "vibe", BaseURL: "https://api.mistral.ai/v1", Models: []internalconfig.OpenAICompatibilityModel{{Name: "mistral-vibe-cli-latest"}}},
		},
	}
	api := &coreauth.Auth{ID: "adopt-mistral-api", Provider: "mistral", Status: coreauth.StatusActive,
		Attributes: map[string]string{"auth_kind": "apikey", "compat_name": "mistral", "provider_key": "mistral"}}
	vibe := &coreauth.Auth{ID: "adopt-mistral-vibe", Provider: "vibe", Prefix: "vibe", Status: coreauth.StatusActive,
		Attributes: map[string]string{"auth_kind": "apikey", "compat_name": "vibe", "provider_key": "vibe"}}
	service := newAdoptionTestService(t, cfg, api, vibe)
	reg := registry.GetGlobalRegistry()
	if !reg.ClientSupportsModel(vibe.ID, "vibe/mistral-vibe-cli-latest") {
		t.Fatal("test setup: the vibe credential should serve its prefixed model")
	}

	// Family: a newer Mistral model goes to the unprefixed API key only.
	if !service.adoptUnknownModel("mistral-large-3", "") {
		t.Fatal("mistral-large-3 was not adopted")
	}
	if got := modelProviders("mistral-large-3"); !got["mistral"] || got["vibe"] {
		t.Fatalf("providers for mistral-large-3 = %v, want only mistral", got)
	}

	// Credential prefix: vibe/<model> lands on the Vibe key as that prefixed ID.
	if !service.adoptUnknownModel("vibe/mistral-vibe-cli-2", "") {
		t.Fatal("vibe/mistral-vibe-cli-2 was not adopted")
	}
	if !reg.ClientSupportsModel(vibe.ID, "vibe/mistral-vibe-cli-2") || reg.ClientSupportsModel(api.ID, "vibe/mistral-vibe-cli-2") {
		t.Fatal("the prefixed model must be served by the Vibe key only")
	}

	// Scope: any name goes to the scoped provider, even outside its families.
	if !service.adoptUnknownModel("ministral-14b", "mistral") || !modelProviders("ministral-14b")["mistral"] {
		t.Fatalf("scoped adoption failed: %v", modelProviders("ministral-14b"))
	}
	// Scope also keeps adoption off other providers.
	if service.adoptUnknownModel("codestral-9", "openai") {
		t.Fatal("a scope without credentials must not adopt")
	}
}

func TestGetRequestDetailsResolverInstalledByService(t *testing.T) {
	auth := oauthAuth("adopt-claude-resolver", "claude")
	service := newAdoptionTestService(t, &config.Config{}, auth)
	registry.SetUnknownModelResolver(service.adoptUnknownModel)
	t.Cleanup(func() { registry.SetUnknownModelResolver(nil) })

	if !registry.ResolveUnknownModel("claude-resolvertest-9-9", "") || !modelProviders("claude-resolvertest-9-9")["claude"] {
		t.Fatal("the installed resolver did not adopt the model")
	}
}

func TestClaudeSubscriptionPublishesOnlyToClaudeCode(t *testing.T) {
	sub := oauthAuth("claude-subscription-catalog-test", "claude")
	setup := &coreauth.Auth{ID: "claude-setup-catalog-test", Provider: "claude", Attributes: map[string]string{"api_key": "sk-ant-oat-fixture"}}
	service := newAdoptionTestService(t, &config.Config{}, sub, setup)
	const adopted = "claude-test-subscription-preview"
	if !service.adoptUnknownModel(adopted, "claude") {
		t.Fatal("failed to adopt a new Claude Code model")
	}
	reg := registry.GetGlobalRegistry()
	for _, id := range []string{"claude-mythos-5-1", "claude-mythos-5-2", adopted} {
		if !reg.ClientSupportsModel(sub.ID, id) || !reg.ClientSupportsModel(setup.ID, id) {
			t.Errorf("subscription lost %s", id)
		}
		for _, model := range reg.OpenCodeModels() {
			if model.Info.ID == id {
				t.Errorf("OpenCode lists subscription-only model %s", id)
			}
		}
	}

	key := &coreauth.Auth{ID: "claude-api-key-catalog-test", Provider: "claude", Attributes: map[string]string{"api_key": "test-api-key"}}
	newAdoptionTestService(t, &config.Config{}, key)
	for _, route := range reg.OpenCodeModels() {
		if route.Info.ID == "claude-mythos-5-2" {
			return
		}
	}
	t.Fatal("independent Claude API-key route missing from OpenCode")
}

package registry

import (
	"sort"
	"testing"
)

func TestModelFamily(t *testing.T) {
	for id, want := range map[string]string{
		"claude-mythos-5-2":           "claude",
		"gpt-5.6-codex":               "gpt",
		"o3":                          "o3",
		"Gemini-4-Pro":                "gemini",
		"vibe/mistral-medium-3.5":     "mistral",
		"devstral-2":                  "devstral",
		"kimi-k3":                     "kimi",
		"grok-4.7":                    "grok",
		"claude-opus-5-5[1m]":         "claude",
		"accounts/fireworks/glm-5":    "glm",
		"qwen3-coder:480b":            "qwen3",
		"MiniMax-M2.5":                "minimax",
		"mistral-vibe-cli-latest":     "mistral",
		"devin/claude-fable-5-1":      "claude",
		"meta-llama/llama-4-maverick": "llama",
	} {
		if got := ModelFamily(id); got != want {
			t.Errorf("ModelFamily(%q) = %q, want %q", id, got, want)
		}
	}
}

func TestIsAdoptableModelIDAcceptsAnyRealName(t *testing.T) {
	for _, id := range []string{"claude-opus-5-5[1m]", "MiniMax-M2.5", "vibe/mistral-medium-3.5", "qwen3-coder:480b", "a-very-long-model-name-that-is-well-over-sixty-four-characters-long-for-sure"} {
		if !IsAdoptableModelID(id) {
			t.Errorf("IsAdoptableModelID(%q) = false, want true", id)
		}
	}
	for _, id := range []string{"", "  ", "auto", "claude opus", "claude\n"} {
		if IsAdoptableModelID(id) {
			t.Errorf("IsAdoptableModelID(%q) = true, want false", id)
		}
	}
}

func TestFamilyProvidersPrefersTheProviderServingTheFamily(t *testing.T) {
	r := newTestModelRegistry()
	r.RegisterClient("c-claude", "claude", []*ModelInfo{{ID: "claude-opus-5-5"}, {ID: "claude-fable-5-2"}, {ID: "claude-sonnet-5-5"}})
	r.RegisterClient("c-agy", "antigravity", []*ModelInfo{{ID: "claude-sonnet-4-6"}, {ID: "gemini-3-pro"}})
	r.RegisterClient("c-mistral", "mistral", []*ModelInfo{{ID: "mistral-medium-3.5"}, {ID: "devstral-2"}})
	r.RegisterClient("c-vibe", "vibe", []*ModelInfo{{ID: "vibe/mistral-vibe-cli-latest"}})
	r.RegisterClient("c-devin", "devin", []*ModelInfo{{ID: "devin/swe-2"}})

	check := func(id string, want ...string) {
		t.Helper()
		got := r.FamilyProviders(id)
		sort.Strings(got)
		sort.Strings(want)
		if len(got) != len(want) {
			t.Fatalf("FamilyProviders(%q) = %v, want %v", id, got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Fatalf("FamilyProviders(%q) = %v, want %v", id, got, want)
			}
		}
	}
	check("claude-mythos-5-2", "claude")
	check("gemini-4-pro", "antigravity")
	check("mistral-large-3", "mistral")
	check("devstral-3", "mistral")
	// No credential serves a grok model: the built-in table answers.
	check("grok-5", "xai")
	check("llama-4")

	if got := r.NamespaceProviders("devin"); len(got) != 1 || got[0] != "devin" {
		t.Fatalf("NamespaceProviders(devin) = %v", got)
	}
	if got := r.GetClientProvider("c-vibe"); got != "vibe" {
		t.Fatalf("GetClientProvider(c-vibe) = %q", got)
	}
}

func TestAdoptedModelInfoCopiesClosestSibling(t *testing.T) {
	info := AdoptedModelInfo("claude-opus-5-6", "claude")
	if info.ID != "claude-opus-5-6" || info.DisplayName != "" || info.Type != "claude" {
		t.Fatalf("unexpected adopted info: %+v", info)
	}
	if info.Thinking == nil || len(info.Thinking.Levels) == 0 || info.ContextLength == 0 {
		t.Fatalf("adopted info lost the sibling's capabilities: %+v", info)
	}

	gemini := AdoptedModelInfo("gemini-9-pro", "gemini")
	if gemini.Name != "" && gemini.Name != "models/gemini-9-pro" {
		t.Fatalf("Gemini name = %q, want it rewritten for the adopted ID", gemini.Name)
	}

	// Without a sibling, thinking settings pass through to the upstream.
	bare := AdoptedModelInfo("claude-x", "no-such-provider")
	if bare.ID != "claude-x" || bare.Type != "no-such-provider" || !bare.UserDefined {
		t.Fatalf("fallback info = %+v", bare)
	}
}

func TestResolveUnknownModelPassesScopeAndSkipsNonNames(t *testing.T) {
	var gotModel, gotScope string
	SetUnknownModelResolver(func(model, scope string) bool { gotModel, gotScope = model, scope; return true })
	t.Cleanup(func() { SetUnknownModelResolver(nil) })

	if ResolveUnknownModel("auto", "") || ResolveUnknownModel("", "") {
		t.Fatal("non-names must not resolve")
	}
	if !ResolveUnknownModel(" llama-4 ", "Mistral") || gotModel != "llama-4" || gotScope != "mistral" {
		t.Fatalf("resolver got (%q, %q)", gotModel, gotScope)
	}
}

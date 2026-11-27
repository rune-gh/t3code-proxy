package antigravitycli

import (
	"reflect"
	"strings"
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/registry"
)

func TestIsAntigravityCLIUserAgent(t *testing.T) {
	cases := []struct {
		ua   string
		want bool
	}{
		{"antigravity/cli/1.5.14 (aidev_client; os_type=linux; arch=amd64; auth_method=gateway)", true},
		{"Antigravity/CLI/1.6.0", true},
		{"  antigravity/cli/1.5.14  ", true},
		// agy 1.5.18's ACP server in Gemini API key mode (T3 Code) generates through the Go genai SDK.
		{"google-genai-sdk/1.79.1 gl-go/go1.28-20261102-RC01 cl/1012564305 +298f53e483 X:fieldtrack,boringcrypto,nogolistexportnewformat", true},
		{"google-genai-sdk/1.79.1 gl-go/go1.26.1", false},
		{"google-genai-sdk/1.30.0 gl-node/22.11.0", false},
		{"antigravity/hub/2.29.0", false},
		{"antigravity", false},
		{"curl/8.7.1", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsAntigravityCLIUserAgent(tc.ua); got != tc.want {
			t.Errorf("IsAntigravityCLIUserAgent(%q) = %v, want %v", tc.ua, got, tc.want)
		}
	}
}

func TestResolveLevels(t *testing.T) {
	cases := []struct {
		name    string
		support *registry.ThinkingSupport
		want    []string
	}{
		{
			name:    "nil thinking",
			support: nil,
			want:    nil,
		},
		{
			name:    "filters unsupported minimal/none/auto/ultra and preserves canonical order",
			support: &registry.ThinkingSupport{Levels: []string{"high", "minimal", "low", "none", "medium", "ultra", "auto"}},
			want:    []string{"low", "medium", "high"},
		},
		{
			name:    "xhigh level preserved",
			support: &registry.ThinkingSupport{Levels: []string{"low", "medium", "high", "xhigh"}},
			want:    []string{"low", "medium", "high", "xhigh"},
		},
		{
			name:    "single supported level after filtering minimal",
			support: &registry.ThinkingSupport{Levels: []string{"minimal", "high"}},
			want:    []string{"high"},
		},
		{
			name:    "budget-only claude 4.6 range derives distinct levels",
			support: &registry.ThinkingSupport{Min: 1024, Max: 64000, ZeroAllowed: true, DynamicAllowed: true},
			want:    []string{"low", "medium", "high", "xhigh", "max"},
		},
		{
			name:    "budget-only capped at 24576 drops xhigh and max",
			support: &registry.ThinkingSupport{Min: 1, Max: 24576},
			want:    []string{"low", "medium", "high"},
		},
		{
			name:    "budget pinned to one value yields single level",
			support: &registry.ThinkingSupport{Min: 32768, Max: 32768},
			want:    []string{"xhigh"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveLevels(tc.support)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("ResolveLevels() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestBuildModels_AntigravityCatalogAndForkedAliases(t *testing.T) {
	infos := []*registry.ModelInfo{
		{
			ID:                  "claude-opus-4-6-thinking",
			DisplayName:         "Claude Opus 4.6 (Thinking)",
			Description:         "Claude Opus 4.6 (Thinking)",
			ContextLength:       200000,
			MaxCompletionTokens: 64000,
			Thinking:            &registry.ThinkingSupport{Min: 1024, Max: 64000, ZeroAllowed: true, DynamicAllowed: true},
		},
		{
			ID:                  "claude-opus-5-5-high",
			DisplayName:         "Claude Opus 5.5 (High)",
			Description:         "Claude Opus 5.5 (High)",
			ContextLength:       1000000,
			MaxCompletionTokens: 128000,
			Thinking:            &registry.ThinkingSupport{Min: 1024, Max: 64000, ZeroAllowed: true, DynamicAllowed: true, Levels: []string{"low", "medium", "high"}},
		},
		{
			ID:                  "claude-sonnet-5-5-high",
			DisplayName:         "Claude Sonnet 5.5 (High)",
			Description:         "Claude Sonnet 5.5 (High)",
			ContextLength:       1000000,
			MaxCompletionTokens: 128000,
			Thinking:            &registry.ThinkingSupport{Min: 1024, Max: 64000, ZeroAllowed: true, DynamicAllowed: true, Levels: []string{"low", "medium", "high"}},
		},
		// Forked alias alongside its upstream model — must deduplicate to one model.
		{
			ID:                  "gemini-4-neon",
			MetadataModelID:     "gemini-4-neon-xhigh",
			DisplayName:         "Gemini 4 Neon",
			Description:         "Gemini 4 Neon (XHigh)",
			ContextLength:       1048576,
			MaxCompletionTokens: 65536,
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high", "xhigh"}},
		},
		{
			ID:                  "gemini-4-neon-xhigh",
			DisplayName:         "Gemini 4 Neon",
			Description:         "Gemini 4 Neon (XHigh)",
			ContextLength:       1048576,
			MaxCompletionTokens: 65536,
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high", "xhigh"}},
		},
		// Adopted stub alongside catalog model — catalog model must win.
		{
			ID:                  "gemini-4-argon",
			ContextLength:       1048576,
			MaxCompletionTokens: 65536,
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high"}},
		},
		{
			ID:                  "gemini-4-argon-high",
			DisplayName:         "Gemini 4 Argon",
			Description:         "Gemini 4 Argon (High)",
			ContextLength:       1048576,
			MaxCompletionTokens: 65536,
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high"}},
		},
		{
			ID:                  "gemini-3.8-flash-tiered",
			DisplayName:         "Gemini 3.8 Flash (Tiered)",
			Description:         "Gemini 3.8 Flash (Tiered)",
			ContextLength:       1048576,
			MaxCompletionTokens: 65536,
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high"}},
		},
		{
			ID:                  "gemini-3-flash",
			DisplayName:         "Gemini 3 Flash",
			Description:         "Gemini 3 Flash",
			ContextLength:       1048576,
			MaxCompletionTokens: 65536,
			Thinking:            &registry.ThinkingSupport{Min: 128, Max: 32768, DynamicAllowed: true, Levels: []string{"minimal", "low", "medium", "high"}},
		},
		{
			ID:          "gemini-3.1-flash-image",
			DisplayName: "Gemini 3.1 Flash Image",
			Description: "Gemini 3.1 Flash Image",
			Thinking:    &registry.ThinkingSupport{Min: 128, Max: 32768, DynamicAllowed: true, Levels: []string{"minimal", "high"}},
		},
		{
			ID:                  "gpt-oss-120b-medium",
			DisplayName:         "GPT-OSS 120B (Medium)",
			Description:         "GPT-OSS 120B (Medium)",
			ContextLength:       114000,
			MaxCompletionTokens: 32768,
		},
	}

	got := BuildModels(infos)
	byName := make(map[string]map[string]any, len(got))
	for _, entry := range got {
		name, _ := entry["name"].(string)
		if _, dup := byName[name]; dup {
			t.Fatalf("duplicate model entry %q", name)
		}
		byName[name] = entry
		// Ensure no minimal/none suffixes leak out as separate models.
		if strings.Contains(name, "(minimal)") || strings.Contains(name, "(none)") {
			t.Fatalf("unexpected unsupported level entry %q", name)
		}
		// Ensure strict Gemini Model schema (no unknown fields).
		for key := range entry {
			switch key {
			case "name", "version", "displayName", "description", "thinking", "inputTokenLimit", "outputTokenLimit", "supportedGenerationMethods", "supportedInputModalities", "supportedOutputModalities":
			default:
				t.Fatalf("unexpected non-Gemini field %q on %q", key, name)
			}
		}
	}

	if len(got) > maxCatalogEntries {
		t.Fatalf("len(got) = %d, exceeds Antigravity CLI 32-entry limit", len(got))
	}

	// First entry must belong to a widest-level expanded model so `agy acp`'s
	// initial session/new exposes the broadest thought_level range.
	firstName, _ := got[0]["name"].(string)
	if firstName != "models/claude-opus-4-6-thinking(low)" {
		t.Fatalf("first entry = %q, want models/claude-opus-4-6-thinking(low)", firstName)
	}
	if got[0]["thinking"] != true {
		t.Fatalf("expected thinking=true on expanded Claude model, got %#v", got[0]["thinking"])
	}

	// Check Claude Opus 5.5 expansion and cleaned display name.
	for _, lvl := range []string{"low", "medium", "high"} {
		entry, ok := byName["models/claude-opus-5-5-high("+lvl+")"]
		if !ok {
			t.Fatalf("missing claude-opus-5-5-high(%s)", lvl)
		}
		if dn := entry["displayName"]; dn != "Claude Opus 5.5 ("+lvl+")" {
			t.Fatalf("claude-opus-5-5-high(%s) displayName = %q", lvl, dn)
		}
		if entry["thinking"] != true {
			t.Fatalf("claude-opus-5-5-high(%s) thinking = %#v, want true", lvl, entry["thinking"])
		}
	}
	if _, exists := byName["models/claude-opus-5-5-high"]; exists {
		t.Fatal("unexpanded claude-opus-5-5-high should not be emitted alongside expanded levels")
	}

	// Check Gemini 4 Neon deduplication: only one model group (using canonical ID), no duplicate flat entry.
	for _, lvl := range []string{"low", "medium", "high", "xhigh"} {
		entry, ok := byName["models/gemini-4-neon-xhigh("+lvl+")"]
		if !ok {
			t.Fatalf("missing gemini-4-neon-xhigh(%s)", lvl)
		}
		if dn := entry["displayName"]; dn != "Gemini 4 Neon ("+lvl+")" {
			t.Fatalf("gemini-4-neon-xhigh(%s) displayName = %q", lvl, dn)
		}
		if _, dup := byName["models/gemini-4-neon("+lvl+")"]; dup {
			t.Fatalf("duplicate forked alias entry models/gemini-4-neon(%s) should be deduplicated", lvl)
		}
	}
	if _, exists := byName["models/gemini-4-neon"]; exists {
		t.Fatal("flat gemini-4-neon should not exist alongside expanded group")
	}
	if _, exists := byName["models/gemini-4-neon-xhigh"]; exists {
		t.Fatal("flat gemini-4-neon-xhigh should not exist alongside expanded group")
	}

	// Check adopted stub deduplication against catalog model.
	for _, lvl := range []string{"low", "medium", "high"} {
		if _, ok := byName["models/gemini-4-argon-high("+lvl+")"]; !ok {
			t.Fatalf("missing gemini-4-argon-high(%s)", lvl)
		}
		if _, dup := byName["models/gemini-4-argon("+lvl+")"]; dup {
			t.Fatalf("adopted stub gemini-4-argon(%s) should be deduplicated", lvl)
		}
	}

	// Check Tiered display name flattening avoids double parentheses.
	if dn := byName["models/gemini-3.8-flash-tiered(low)"]["displayName"]; dn != "Gemini 3.8 Flash Tiered (low)" {
		t.Fatalf("tiered displayName = %q, want Gemini 3.8 Flash Tiered (low)", dn)
	}

	// Check single-level and non-thinking models remain flat and at the end.
	if entry, ok := byName["models/gpt-oss-120b-medium"]; !ok || entry["displayName"] != "GPT-OSS 120B (Medium)" {
		t.Fatalf("gpt-oss-120b-medium = %#v", entry)
	} else if _, hasThinking := entry["thinking"]; hasThinking {
		t.Fatalf("non-thinking model should not set thinking=true: %#v", entry)
	}
	if entry, ok := byName["models/gemini-3.1-flash-image"]; !ok || entry["displayName"] != "Gemini 3.1 Flash Image" {
		t.Fatalf("gemini-3.1-flash-image = %#v", entry)
	}
}

func TestBuildModels_FullEmbeddedCatalogFits32SlotLimitWithoutDroppingModels(t *testing.T) {
	infos := append([]*registry.ModelInfo(nil), registry.GetAntigravityModels()...)
	// Add gemini-4-neon-xhigh and forked aliases matching a live account.
	infos = append(infos,
		&registry.ModelInfo{
			ID:                  "gemini-4-neon-xhigh",
			DisplayName:         "Gemini 4 Neon",
			Description:         "Gemini 4 Neon (XHigh)",
			ContextLength:       1048576,
			MaxCompletionTokens: 1048576,
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high", "xhigh"}},
		},
		&registry.ModelInfo{
			ID:                  "gemini-4-neon",
			MetadataModelID:     "gemini-4-neon-xhigh",
			DisplayName:         "Gemini 4 Neon",
			Description:         "Gemini 4 Neon (XHigh)",
			ContextLength:       1048576,
			MaxCompletionTokens: 1048576,
			Thinking:            &registry.ThinkingSupport{Min: 1, Max: 65535, DynamicAllowed: true, Levels: []string{"low", "medium", "high", "xhigh"}},
		},
		&registry.ModelInfo{
			ID:              "gemini-4-argon",
			MetadataModelID: "gemini-4-argon-high",
			DisplayName:     "Gemini 4 Argon",
			Thinking:        &registry.ThinkingSupport{Levels: []string{"low", "medium", "high"}},
		},
	)

	got := BuildModels(infos)
	if len(got) > maxCatalogEntries {
		t.Fatalf("len(got) = %d, want <= %d", len(got), maxCatalogEntries)
	}

	// Count levels per model base ID and track the group appearance order;
	// all 8 flagship models must get prioritized thinking-level expansion (with
	// Neon #1, Hydrogen #2, Carbon #3, Opus 5.5 #4, Sonnet 5.5 #5, 3.8 Flash #6,
	// Argon #7, 3 Flash #8) and every remaining model must stay present without
	// being dropped.
	levelsByModel := make(map[string][]string)
	var expandedOrder []string
	seenExpanded := make(map[string]bool)
	for _, entry := range got {
		name := strings.TrimPrefix(entry["name"].(string), "models/")
		if idx := strings.IndexByte(name, '('); idx > 0 && strings.HasSuffix(name, ")") {
			base := name[:idx]
			lvl := name[idx+1 : len(name)-1]
			levelsByModel[base] = append(levelsByModel[base], lvl)
			if !seenExpanded[base] {
				seenExpanded[base] = true
				expandedOrder = append(expandedOrder, base)
			}
		} else {
			levelsByModel[name] = nil
		}
	}

	wantFlagshipOrder := []string{
		"gemini-4-neon-xhigh",
		"gemini-4-hydrogen-xhigh",
		"gemini-4-carbon-high",
		"claude-opus-5-5-high",
		"claude-sonnet-5-5-high",
		"gemini-3.8-flash-high",
		"gemini-4-argon-high",
		"gemini-3-flash",
	}
	if !reflect.DeepEqual(expandedOrder, wantFlagshipOrder) {
		t.Errorf("expandedOrder = %v, want %v", expandedOrder, wantFlagshipOrder)
	}

	wantFlagshipLevels := map[string][]string{
		"gemini-4-neon-xhigh":     {"low", "medium", "high", "xhigh"},
		"gemini-4-hydrogen-xhigh": {"low", "medium", "high", "xhigh"},
		"gemini-4-carbon-high":    {"low", "medium", "high"},
		"claude-opus-5-5-high":    {"low", "medium", "high"},
		"claude-sonnet-5-5-high":  {"low", "medium", "high"},
		"gemini-3.8-flash-high":   {"low", "medium", "high"},
		"gemini-4-argon-high":     {"low", "medium", "high"},
		"gemini-3-flash":          {"low", "high"},
	}
	for id, wantLvls := range wantFlagshipLevels {
		if gotLvls := levelsByModel[id]; !reflect.DeepEqual(gotLvls, wantLvls) {
			t.Errorf("flagship model %q levels = %v, want %v", id, gotLvls, wantLvls)
		}
	}
	for _, flatID := range []string{
		"claude-opus-4-6-thinking",
		"claude-sonnet-4-6",
		"gemini-3.8-flash-tiered",
		"gemini-3.1-flash-lite",
		"gemini-3.5-flash-lite",
		"gemini-3.1-flash-image",
		"gpt-oss-120b-medium",
	} {
		if lvls, ok := levelsByModel[flatID]; !ok || len(lvls) != 0 {
			t.Errorf("flat model %q missing or unexpectedly expanded: ok=%v lvls=%v", flatID, ok, lvls)
		}
	}
	if len(got) != maxCatalogEntries {
		t.Errorf("len(got) = %d, want exact %d", len(got), maxCatalogEntries)
	}
	if _, dup := levelsByModel["gemini-4-neon"]; dup {
		t.Error("forked alias gemini-4-neon should be deduplicated")
	}
	if _, dup := levelsByModel["gemini-4-argon"]; dup {
		t.Error("forked alias gemini-4-argon should be deduplicated")
	}

	// Ensure models whose catalog max_completion_tokens equals context_length
	// (like gemini-4-hydrogen-xhigh at 1048576/1048576) omit outputTokenLimit so
	// agy's planner executor does not compute zero available prompt tokens.
	for _, entry := range got {
		inLim, hasIn := entry["inputTokenLimit"].(int)
		outLim, hasOut := entry["outputTokenLimit"].(int)
		if hasIn && hasOut && outLim >= inLim {
			t.Errorf("model %q has outputTokenLimit (%d) >= inputTokenLimit (%d)", entry["name"], outLim, inLim)
		}
	}
}

func TestBuildModels_DistinctEffortVariantUpstreamModels(t *testing.T) {
	infos := []*registry.ModelInfo{
		{ID: "claude-opus-5-5-low", DisplayName: "Claude Opus 5.5 (Low)"},
		{ID: "claude-opus-5-5-medium", DisplayName: "Claude Opus 5.5 (Medium)"},
		{ID: "claude-opus-5-5-high", DisplayName: "Claude Opus 5.5 (High)"},
		{ID: "claude-opus-5-5-max", DisplayName: "Claude Opus 5.5 (Max)"},
	}

	got := BuildModels(infos)
	if len(got) != 4 {
		t.Fatalf("len(got) = %d, want 4: %#v", len(got), got)
	}
	wantNames := []string{
		"models/claude-opus-5-5-low",
		"models/claude-opus-5-5-medium",
		"models/claude-opus-5-5-high",
		"models/claude-opus-5-5-max",
	}
	wantDisplays := []string{
		"Claude Opus 5.5 (low)",
		"Claude Opus 5.5 (medium)",
		"Claude Opus 5.5 (high)",
		"Claude Opus 5.5 (max)",
	}
	for i := range wantNames {
		if got[i]["name"] != wantNames[i] {
			t.Errorf("got[%d].name = %q, want %q", i, got[i]["name"], wantNames[i])
		}
		if got[i]["displayName"] != wantDisplays[i] {
			t.Errorf("got[%d].displayName = %q, want %q", i, got[i]["displayName"], wantDisplays[i])
		}
	}
}

func TestBuildModels_PreservesCustomNamedAliasAndPreSuffixedIDs(t *testing.T) {
	infos := []*registry.ModelInfo{
		{
			ID:               "gemini-4-neon-xhigh",
			DisplayName:      "Gemini 4 Neon",
			Thinking:         &registry.ThinkingSupport{Levels: []string{"low", "medium", "high", "xhigh"}},
			ContextLength:    1048576,
			OutputTokenLimit: 65536,
		},
		{
			ID:              "my-custom-neon",
			MetadataModelID: "gemini-4-neon-xhigh",
			DisplayName:     "My Custom Neon",
			Thinking:        &registry.ThinkingSupport{Levels: []string{"low", "medium", "high", "xhigh"}},
		},
		{
			ID:          "pinned-model(high)",
			DisplayName: "Pinned Model (high)",
		},
		{
			ID:          "team/gemini-4-argon-high",
			DisplayName: "Team Gemini 4 Argon",
			Thinking:    &registry.ThinkingSupport{Levels: []string{"low", "medium", "high"}},
		},
	}

	got := BuildModels(infos)
	byName := make(map[string]map[string]any, len(got))
	for _, entry := range got {
		byName[entry["name"].(string)] = entry
	}
	if _, ok := byName["models/my-custom-neon(xhigh)"]; !ok {
		t.Fatalf("custom alias should remain expanded separately, got keys: %v", mapKeys(byName))
	}
	if _, ok := byName["models/pinned-model(high)"]; !ok {
		t.Fatalf("pre-suffixed model should pass through untouched, got keys: %v", mapKeys(byName))
	}
	if _, ok := byName["models/team/gemini-4-argon-high(medium)"]; !ok {
		t.Fatalf("prefixed model should expand cleanly, got keys: %v", mapKeys(byName))
	}
}

func TestBuildModels_ForkedClaudeThinkingAliasDeduplicates(t *testing.T) {
	infos := []*registry.ModelInfo{
		{
			ID:              "claude-opus-4-6",
			MetadataModelID: "claude-opus-4-6-thinking",
			DisplayName:     "Claude Opus 4.6 (Thinking)",
			Thinking:        &registry.ThinkingSupport{Min: 1024, Max: 64000},
		},
		{
			ID:          "claude-opus-4-6-thinking",
			DisplayName: "Claude Opus 4.6 (Thinking)",
			Thinking:    &registry.ThinkingSupport{Min: 1024, Max: 64000},
		},
	}

	got := BuildModels(infos)
	if len(got) != 5 {
		t.Fatalf("len(got) = %d, want 5: %#v", len(got), got)
	}
	for _, entry := range got {
		name := entry["name"].(string)
		if !strings.HasPrefix(name, "models/claude-opus-4-6-thinking(") {
			t.Fatalf("unexpected entry %q", name)
		}
	}
}

func TestBuildModels_SupplementalEffortVariantAndNonThinkingPair(t *testing.T) {
	infos := []*registry.ModelInfo{
		// Unsuffixed model covers low..high while a dedicated -xhigh variant adds xhigh.
		{
			ID:          "gemini-4-neon",
			DisplayName: "Gemini 4 Neon",
			Thinking:    &registry.ThinkingSupport{Levels: []string{"low", "medium", "high"}},
		},
		{
			ID:          "gemini-4-neon-xhigh",
			DisplayName: "Gemini 4 Neon (XHigh)",
		},
		// Distinct non-thinking catalog models are not silently dropped.
		{
			ID:          "gpt-oss-120b",
			DisplayName: "GPT-OSS 120B",
		},
		{
			ID:          "gpt-oss-120b-medium",
			DisplayName: "GPT-OSS 120B (Medium)",
		},
	}

	got := BuildModels(infos)
	byName := make(map[string]map[string]any, len(got))
	for _, entry := range got {
		byName[entry["name"].(string)] = entry
	}
	for _, lvl := range []string{"low", "medium", "high"} {
		entry, ok := byName["models/gemini-4-neon("+lvl+")"]
		if !ok || entry["displayName"] != "Gemini 4 Neon ("+lvl+")" {
			t.Fatalf("missing/invalid gemini-4-neon(%s): %#v", lvl, entry)
		}
	}
	if entry, ok := byName["models/gemini-4-neon-xhigh"]; !ok || entry["displayName"] != "Gemini 4 Neon (xhigh)" {
		t.Fatalf("expected dedicated xhigh route, got: %#v", entry)
	}
	if _, ok := byName["models/gpt-oss-120b"]; !ok {
		t.Fatalf("expected gpt-oss-120b to be preserved, got keys: %v", mapKeys(byName))
	}
	if _, ok := byName["models/gpt-oss-120b-medium"]; !ok {
		t.Fatalf("expected gpt-oss-120b-medium to be preserved, got keys: %v", mapKeys(byName))
	}
}

func TestFindModel(t *testing.T) {
	infos := []*registry.ModelInfo{
		{
			ID:          "claude-opus-5-5-high",
			DisplayName: "Claude Opus 5.5 (High)",
			Thinking:    &registry.ThinkingSupport{Levels: []string{"low", "medium", "high"}},
		},
	}
	if m := FindModel(infos, "claude-opus-5-5-high(medium)"); m == nil || m["displayName"] != "Claude Opus 5.5 (medium)" {
		t.Fatalf("FindModel(bare) = %#v", m)
	}
	if m := FindModel(infos, "models/claude-opus-5-5-high(high)"); m == nil || m["displayName"] != "Claude Opus 5.5 (high)" {
		t.Fatalf("FindModel(prefixed) = %#v", m)
	}
	if m := FindModel(infos, "nonexistent"); m != nil {
		t.Fatalf("FindModel(nonexistent) = %#v, want nil", m)
	}
}

func mapKeys(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

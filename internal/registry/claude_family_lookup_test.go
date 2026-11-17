package registry

import "testing"

func TestLookupStaticModelInfoClaudeVariantsUseCatalogEntry(t *testing.T) {
	tests := []struct {
		id     string
		family string
	}{
		{id: "claude-opus-5-5[1m]", family: "claude-opus-5-5"},
		{id: "claude-opus-5-5-20261001", family: "claude-opus-5-5"},
		{id: "claude-opus-5-5-20261001[1m]", family: "claude-opus-5-5"},
		{id: "claude-sonnet-5-5[1m]", family: "claude-sonnet-5-5"},
		{id: "claude-sonnet-5-5-20261001", family: "claude-sonnet-5-5"},
		{id: "claude-fable-5[1m]", family: "claude-fable-5"},
		{id: "claude-fable-5-1[1m]", family: "claude-fable-5-1"},
		{id: "claude-haiku-4-5-20251001[1m]", family: "claude-haiku-4-5-20251001"},
	}
	for _, tt := range tests {
		info := LookupStaticModelInfo(tt.id)
		if info == nil || info.ID != tt.family {
			t.Errorf("LookupStaticModelInfo(%q) = %+v, want catalog entry %q", tt.id, info, tt.family)
		}
		chInfo := LookupStaticModelInfoByChannel(tt.id, "claude")
		if chInfo == nil || chInfo.ID != tt.family {
			t.Errorf("LookupStaticModelInfoByChannel(%q, \"claude\") = %+v, want catalog entry %q", tt.id, chInfo, tt.family)
		}
	}

	// Exact catalog IDs keep winning, and only Claude variants are normalized.
	if info := LookupStaticModelInfo("claude-haiku-4-5-20251001"); info == nil || info.ID != "claude-haiku-4-5-20251001" {
		t.Errorf("exact dated ID resolved to %+v", info)
	}
	for _, id := range []string{"claude-unknown-20261001", "claude-opus-5-5-2026", "claude-opus-5-5[1m", "gpt-5[1m]"} {
		if info := LookupStaticModelInfo(id); info != nil {
			t.Errorf("LookupStaticModelInfo(%q) = %q, want nil", id, info.ID)
		}
	}
}

func TestClaudeModelsIncludeMythosBuiltins(t *testing.T) {
	for _, id := range []string{"claude-mythos-5-1", "claude-mythos-5-2"} {
		found := false
		for _, model := range GetClaudeModels() {
			if model != nil && model.ID == id {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("GetClaudeModels() is missing %q; Claude Code requests for it would fail with unknown provider", id)
		}
		if info := LookupStaticModelInfoByChannel(id+"[1m]", "claude"); info == nil || info.ID != id {
			t.Errorf("LookupStaticModelInfoByChannel(%q[1m]) = %+v, want %q", id, info, id)
		}
		if info := LookupStaticModelInfo(id); info == nil || info.Thinking == nil {
			t.Errorf("LookupStaticModelInfo(%q) = %+v, want an entry with thinking support", id, info)
		}
	}
}

func TestWithClaudeBuiltinsKeepsCatalogEntries(t *testing.T) {
	catalog := []*ModelInfo{{ID: "claude-mythos-5-2", DisplayName: "From catalog"}}
	models := withClaudeBuiltins(catalog)
	count := 0
	for _, model := range models {
		if model.ID == "claude-mythos-5-2" {
			count++
			if model.DisplayName != "From catalog" {
				t.Errorf("builtin replaced the catalog entry: %+v", model)
			}
		}
	}
	if count != 1 {
		t.Errorf("claude-mythos-5-2 appears %d times, want 1", count)
	}
	if len(catalog) != 1 {
		t.Errorf("input catalog was modified: %d entries", len(catalog))
	}
}

package registry

import (
	"encoding/json"
	"strings"
	"testing"
)

// isolateCodexAccountModels restores the Codex client catalog store and the
// refresh notifications after the test.
func isolateCodexAccountModels(t *testing.T) {
	t.Helper()
	store := codexClientCatalogStore
	store.mu.Lock()
	saved := struct {
		base         []byte
		baseSlugs    map[string]struct{}
		account      map[string]codexAccountModel
		accountTiers map[string]map[string]struct{}
		data         []byte
		revision     uint64
		lite         map[string]bool
		levels       map[string][]string
	}{store.base, store.baseSlugs, store.account, store.accountTiers, store.data, store.revision, store.responsesLiteMap, store.thinkingLevelsMap}
	store.account, store.accountTiers = nil, nil
	store.mu.Unlock()

	refreshCallbackMu.Lock()
	savedCallback, savedPending := refreshCallback, pendingRefreshChanges
	refreshCallback, pendingRefreshChanges = nil, nil
	refreshCallbackMu.Unlock()

	t.Cleanup(func() {
		store.mu.Lock()
		store.base, store.baseSlugs, store.account, store.accountTiers = saved.base, saved.baseSlugs, saved.account, saved.accountTiers
		store.data, store.revision, store.responsesLiteMap, store.thinkingLevelsMap = saved.data, saved.revision, saved.lite, saved.levels
		store.mu.Unlock()
		refreshCallbackMu.Lock()
		refreshCallback, pendingRefreshChanges = savedCallback, savedPending
		refreshCallbackMu.Unlock()
	})
}

// accountModelEntry clones an embedded catalog entry under a new slug.
func accountModelEntry(t *testing.T, fromSlug, slug, displayName, visibility string) map[string]any {
	t.Helper()
	var payload codexClientModelsPayload
	if err := json.Unmarshal(embeddedCodexClientModelsJSON, &payload); err != nil {
		t.Fatalf("decode embedded catalog: %v", err)
	}
	for _, model := range payload.Models {
		if model["slug"] == fromSlug {
			model["slug"] = slug
			model["display_name"] = displayName
			model["visibility"] = visibility
			return model
		}
	}
	t.Fatalf("embedded catalog has no %q", fromSlug)
	return nil
}

func accountModelsBody(t *testing.T, models ...map[string]any) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{"models": models})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return body
}

func catalogSlugs(t *testing.T) map[string]map[string]any {
	t.Helper()
	var payload codexClientModelsPayload
	if err := json.Unmarshal(GetCodexClientModelsJSON(), &payload); err != nil {
		t.Fatalf("decode served catalog: %v", err)
	}
	out := make(map[string]map[string]any, len(payload.Models))
	for _, model := range payload.Models {
		out[model["slug"].(string)] = model
	}
	return out
}

func findModel(models []*ModelInfo, id string) *ModelInfo {
	for _, model := range models {
		if model != nil && model.ID == id {
			return model
		}
	}
	return nil
}

func TestMergeCodexAccountModelsAddsModelsTheCatalogLacks(t *testing.T) {
	isolateCodexAccountModels(t)
	revision := GetCodexClientModelsRevision()

	known := accountModelEntry(t, "gpt-6.1-sol", "gpt-6.1-sol", "Account Renamed 6.1", "list")
	added := accountModelEntry(t, "gpt-6.1-sol", "gpt-6.2-sol", "GPT-6.2-Sol", "list")
	hidden := accountModelEntry(t, "gpt-6.1-sol", "gpt-reserve", "GPT-Reserve", "hide")
	invalid := map[string]any{"slug": "broken-model"}

	changed, err := MergeCodexAccountModels("plus", accountModelsBody(t, known, added, hidden, invalid))
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if !changed {
		t.Fatal("expected the merge to report a change")
	}
	if GetCodexClientModelsRevision() == revision {
		t.Fatal("expected the Codex client catalog revision to advance")
	}

	served := catalogSlugs(t)
	if served["gpt-6.2-sol"] == nil {
		t.Fatal("gpt-6.2-sol missing from the served Codex client catalog")
	}
	if served["gpt-6.1-sol"]["display_name"] == "Account Renamed 6.1" {
		t.Fatal("an account entry replaced a catalog entry")
	}
	if served["broken-model"] != nil {
		t.Fatal("an invalid account entry was served")
	}
	if levels := CodexClientModelThinkingLevels("gpt-6.2-sol"); len(levels) == 0 {
		t.Fatal("expected thinking levels for gpt-6.2-sol")
	}

	plus := GetCodexPlusModels()
	info := findModel(plus, "gpt-6.2-sol")
	if info == nil {
		t.Fatal("gpt-6.2-sol missing from the plus models")
	}
	if info.DisplayName != "GPT-6.2-Sol" {
		t.Fatalf("display name = %q, want GPT-6.2-Sol", info.DisplayName)
	}
	sibling := findModel(plus, "gpt-6.1-sol")
	if sibling == nil || info.ContextLength != sibling.ContextLength || info.Thinking == nil ||
		strings.Join(info.Thinking.Levels, ",") != strings.Join(sibling.Thinking.Levels, ",") {
		t.Fatalf("gpt-6.2-sol should copy gpt-6.1-sol capabilities, got %+v", info)
	}
	if findModel(plus, "gpt-reserve") != nil {
		t.Fatal("a hidden account model was listed")
	}
	if findModel(GetCodexFreeModels(), "gpt-6.2-sol") != nil {
		t.Fatal("a plus account's model leaked into the free tier")
	}
	if LookupStaticModelInfo("gpt-6.2-sol") == nil {
		t.Fatal("static lookup does not find the account model")
	}

	again, err := MergeCodexAccountModels("plus", accountModelsBody(t, known, added, hidden))
	if err != nil {
		t.Fatalf("second merge: %v", err)
	}
	if again {
		t.Fatal("an identical answer should not report a change")
	}
}

func TestMergeCodexAccountModelsNotifiesCodexReregistration(t *testing.T) {
	isolateCodexAccountModels(t)
	var notified []string
	SetModelRefreshCallback(func(providers []string) { notified = append(notified, providers...) })

	added := accountModelEntry(t, "gpt-6.1-sol", "gpt-6.2-astra", "GPT-6.2-Astra", "list")
	if _, err := MergeCodexAccountModels("prolite", accountModelsBody(t, added)); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if strings.Join(notified, ",") != "codex" {
		t.Fatalf("notified %v, want [codex]", notified)
	}
	if findModel(GetCodexModelsForPlan("prolite"), "gpt-6.2-astra") == nil {
		t.Fatal("a prolite account's model should be listed for its plan")
	}

	notified = nil
	known := accountModelEntry(t, "gpt-6.1-sol", "gpt-6.1-sol", "GPT-6.1-Sol", "list")
	if _, err := MergeCodexAccountModels("prolite", accountModelsBody(t, known)); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if len(notified) != 0 {
		t.Fatalf("a model the catalog already lists should not notify, got %v", notified)
	}
}

func TestCodexCatalogReloadKeepsAccountModelsAndCatalogWins(t *testing.T) {
	isolateCodexAccountModels(t)
	added := accountModelEntry(t, "gpt-6.1-sol", "gpt-6.2-sol", "GPT-6.2-Sol", "list")
	if _, err := MergeCodexAccountModels("pro", accountModelsBody(t, added)); err != nil {
		t.Fatalf("merge: %v", err)
	}

	// A catalog refresh without the model keeps the account entry.
	if _, err := loadCodexClientModelsFromBytes(append([]byte(nil), embeddedCodexClientModelsJSON...), "test"); err != nil {
		t.Fatalf("reload: %v", err)
	}
	if catalogSlugs(t)["gpt-6.2-sol"]["display_name"] != "GPT-6.2-Sol" {
		t.Fatal("a catalog reload dropped the account model")
	}

	// Once the catalog lists the model, its entry is served instead.
	var payload map[string]any
	if err := json.Unmarshal(embeddedCodexClientModelsJSON, &payload); err != nil {
		t.Fatalf("decode: %v", err)
	}
	curated := accountModelEntry(t, "gpt-6.1-sol", "gpt-6.2-sol", "Curated 6.2", "list")
	payload["models"] = append(payload["models"].([]any), curated)
	withModel, _ := json.Marshal(payload)
	if _, err := loadCodexClientModelsFromBytes(withModel, "test"); err != nil {
		t.Fatalf("reload with model: %v", err)
	}
	served := catalogSlugs(t)
	if served["gpt-6.2-sol"]["display_name"] != "Curated 6.2" {
		t.Fatalf("catalog entry should win, served %v", served["gpt-6.2-sol"]["display_name"])
	}
	count := 0
	var all codexClientModelsPayload
	_ = json.Unmarshal(GetCodexClientModelsJSON(), &all)
	for _, model := range all.Models {
		if model["slug"] == "gpt-6.2-sol" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("gpt-6.2-sol served %d times, want once", count)
	}
}

func TestMergeCodexAccountModelsRejectsUnusableAnswers(t *testing.T) {
	isolateCodexAccountModels(t)
	revision := GetCodexClientModelsRevision()
	for _, body := range []string{`not json`, `{"models":[]}`, `{"models":[{"slug":"x"}]}`} {
		if changed, err := MergeCodexAccountModels("plus", []byte(body)); err == nil || changed {
			t.Fatalf("body %q: changed=%v err=%v, want an error", body, changed, err)
		}
	}
	if GetCodexClientModelsRevision() != revision {
		t.Fatal("a rejected answer changed the catalog")
	}
}

func TestClosestCodexSiblingPrefersSameVariant(t *testing.T) {
	models := []*ModelInfo{
		{ID: "gpt-6.1-terra", Created: 300},
		{ID: "gpt-6.1-sol", Created: 200},
		{ID: "gpt-6-astra", Created: 100},
		{ID: "gpt-image-2", Created: 400},
	}
	for slug, want := range map[string]string{
		"gpt-6.2-sol":   "gpt-6.1-sol",
		"gpt-6.2-astra": "gpt-6-astra",
		"gpt-6.2-nova":  "gpt-6.1-terra",
	} {
		if got := closestCodexSibling(slug, models); got == nil || got.ID != want {
			t.Fatalf("closestCodexSibling(%q) = %v, want %s", slug, got, want)
		}
	}
}

func TestCodexPlanTier(t *testing.T) {
	for plan, want := range map[string]string{
		"plus": "plus", "PRO": "pro", "prolite": "pro", "": "pro",
		"team": "team", "business": "team", "go": "team", "free": "free",
	} {
		if got := CodexPlanTier(plan); got != want {
			t.Fatalf("CodexPlanTier(%q) = %q, want %q", plan, got, want)
		}
	}
}

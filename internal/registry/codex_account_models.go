package registry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/MoeForge/moego/ojson"
	log "github.com/sirupsen/logrus"
)

// Codex account model discovery fills the gap between OpenAI shipping a model
// and the community catalogs (models.json, codex_client_models.json) listing
// it. Each ChatGPT account reports the Codex models it can use through
// GET /backend-api/codex/models; the service merges those answers here.
//
// The catalogs keep precedence: an account-reported model only adds a slug the
// catalogs do not know yet, so curated entries are never replaced. Discovery
// only adds models, it never removes catalog ones.

// CodexAccountModelsClientVersion is the client_version sent when an account
// lists its models. The endpoint hides models whose minimal_client_version is
// above it, so a high value returns every model; the hub applies each client's
// own version gate when it answers that client.
const CodexAccountModelsClientVersion = "99.0.0"

// codexAccountModel is one model entry as a ChatGPT account served it.
type codexAccountModel struct {
	raw   []byte
	entry map[string]any
}

// CodexPlanTier maps a ChatGPT plan type to the models.json Codex tier that
// lists its models: "free", "team", "plus" or "pro". Unknown plans (prolite,
// promax, enterprise, ...) use the pro tier.
func CodexPlanTier(planType string) string {
	switch strings.ToLower(strings.TrimSpace(planType)) {
	case "plus":
		return "plus"
	case "team", "business", "go":
		return "team"
	case "free":
		return "free"
	default:
		return "pro"
	}
}

// GetCodexModelsForPlan returns the Codex model definitions for a ChatGPT plan type.
func GetCodexModelsForPlan(planType string) []*ModelInfo {
	switch CodexPlanTier(planType) {
	case "plus":
		return GetCodexPlusModels()
	case "team":
		return GetCodexTeamModels()
	case "free":
		return GetCodexFreeModels()
	default:
		return GetCodexProModels()
	}
}

func codexTierCatalogModels(data *staticModelsJSON, tier string) []*ModelInfo {
	if data == nil {
		return nil
	}
	switch tier {
	case "plus":
		return data.CodexPlus
	case "team":
		return data.CodexTeam
	case "free":
		return data.CodexFree
	default:
		return data.CodexPro
	}
}

// MergeCodexAccountModels records the models a ChatGPT account of planType
// reported (the body of GET /backend-api/codex/models). Entries that fail the
// Codex client catalog validation are skipped. It reports whether the models
// the hub serves changed, and if so asks the service to re-register Codex
// credentials, like a catalog refresh does.
func MergeCodexAccountModels(planType string, data []byte) (bool, error) {
	var payload struct {
		Models []json.RawMessage `json:"models"`
	}
	if errUnmarshal := json.Unmarshal(data, &payload); errUnmarshal != nil {
		return false, fmt.Errorf("decode Codex account models: %w", errUnmarshal)
	}
	tier := CodexPlanTier(planType)
	reported := make(map[string]codexAccountModel, len(payload.Models))
	for i, raw := range payload.Models {
		var entry map[string]any
		if errUnmarshal := json.Unmarshal(raw, &entry); errUnmarshal != nil || entry == nil {
			continue
		}
		slug, errSlug := requiredCodexClientModelString(entry, "slug")
		if errSlug != nil {
			continue
		}
		if errValidate := validateCodexClientModel(entry); errValidate != nil {
			log.Debugf("codex account models: skipping models[%d] %q: %v", i, slug, errValidate)
			continue
		}
		var compact bytes.Buffer
		if errCompact := json.Compact(&compact, raw); errCompact != nil {
			continue
		}
		reported[slug] = codexAccountModel{raw: compact.Bytes(), entry: entry}
	}
	if len(reported) == 0 {
		return false, fmt.Errorf("Codex account models: no usable models in response")
	}

	store := codexClientCatalogStore
	tierCatalog := make(map[string]struct{})
	for _, model := range codexTierCatalogModels(getModels(), tier) {
		if model != nil {
			tierCatalog[strings.ToLower(strings.TrimSpace(model.ID))] = struct{}{}
		}
	}

	store.mu.Lock()
	if store.account == nil {
		store.account = make(map[string]codexAccountModel)
	}
	if store.accountTiers == nil {
		store.accountTiers = make(map[string]map[string]struct{})
	}
	if store.accountTiers[tier] == nil {
		store.accountTiers[tier] = make(map[string]struct{})
	}
	tierGained := false
	for slug, model := range reported {
		store.account[slug] = model
		if _, known := store.accountTiers[tier][slug]; known {
			continue
		}
		store.accountTiers[tier][slug] = struct{}{}
		if _, inCatalog := tierCatalog[strings.ToLower(slug)]; !inCatalog && codexAccountModelListed(model.entry) {
			tierGained = true
		}
	}
	catalogChanged, errCompose := store.composeLocked()
	store.mu.Unlock()
	if errCompose != nil {
		return false, errCompose
	}

	changed := catalogChanged || tierGained
	if changed {
		notifyModelRefresh([]string{"codex"})
	}
	return changed, nil
}

// ResetCodexAccountModels drops every account-reported model, leaving the
// configured catalogs alone. Tests outside this package use it to clean up.
func ResetCodexAccountModels() {
	store := codexClientCatalogStore
	store.mu.Lock()
	store.account, store.accountTiers = nil, nil
	_, errCompose := store.composeLocked()
	store.mu.Unlock()
	if errCompose != nil {
		log.WithError(errCompose).Warn("codex account models: reset failed")
	}
}

// composeLocked rebuilds the served Codex client catalog: the configured
// catalog followed by the account-reported models it does not list. It reports
// whether the served bytes changed. The caller holds s.mu.
func (s *codexClientModelsStore) composeLocked() (bool, error) {
	data := s.base
	if extra := s.accountEntriesMissingFromBaseLocked(); len(extra) > 0 {
		doc := ojson.NewDoc(append([]byte(nil), s.base...))
		for _, raw := range extra {
			if errSet := doc.SetRawBytes("models.-1", raw); errSet != nil {
				return false, fmt.Errorf("compose Codex client model catalog: %w", errSet)
			}
		}
		data = doc.Bytes()
	}
	if s.data != nil && bytes.Equal(s.data, data) {
		return false, nil
	}
	responsesLiteMap, thinkingLevelsMap, errValidate := parseAndValidateCodexClientModelsJSON(data)
	if errValidate != nil {
		return false, fmt.Errorf("compose Codex client model catalog: %w", errValidate)
	}
	s.data = append([]byte(nil), data...)
	s.responsesLiteMap = responsesLiteMap
	s.thinkingLevelsMap = thinkingLevelsMap
	s.revision++
	return true, nil
}

// accountEntriesMissingFromBaseLocked returns the account-reported entries
// whose slug the configured catalog does not list, ordered by slug.
func (s *codexClientModelsStore) accountEntriesMissingFromBaseLocked() [][]byte {
	if len(s.account) == 0 {
		return nil
	}
	slugs := make([]string, 0, len(s.account))
	for slug := range s.account {
		if _, inBase := s.baseSlugs[slug]; !inBase {
			slugs = append(slugs, slug)
		}
	}
	sort.Strings(slugs)
	out := make([][]byte, 0, len(slugs))
	for _, slug := range slugs {
		out = append(out, s.account[slug].raw)
	}
	return out
}

func codexAccountModelListed(entry map[string]any) bool {
	visibility, _ := entry["visibility"].(string)
	return strings.EqualFold(strings.TrimSpace(visibility), "list")
}

// withCodexAccountModels appends the listed models accounts of tier reported
// that models does not contain. An empty tier uses every tier. The input slice
// is never modified.
func withCodexAccountModels(tier string, models []*ModelInfo) []*ModelInfo {
	store := codexClientCatalogStore
	store.mu.RLock()
	var slugs []string
	entries := make(map[string]map[string]any)
	for t, tierSlugs := range store.accountTiers {
		if tier != "" && t != tier {
			continue
		}
		for slug := range tierSlugs {
			model, ok := store.account[slug]
			if !ok || !codexAccountModelListed(model.entry) {
				continue
			}
			if _, seen := entries[slug]; !seen {
				entries[slug] = model.entry
				slugs = append(slugs, slug)
			}
		}
	}
	store.mu.RUnlock()
	if len(slugs) == 0 {
		return models
	}

	present := make(map[string]struct{}, len(models))
	for _, model := range models {
		if model != nil {
			present[strings.ToLower(strings.TrimSpace(model.ID))] = struct{}{}
		}
	}
	sort.Strings(slugs)
	out := make([]*ModelInfo, len(models), len(models)+len(slugs))
	copy(out, models)
	for _, slug := range slugs {
		if _, exists := present[strings.ToLower(slug)]; exists {
			continue
		}
		out = append(out, codexAccountModelInfo(slug, entries[slug], models))
	}
	return out
}

// codexAccountModelInfo builds the registry definition of an account-reported
// model. It copies the catalog model closest to it (same variant name such as
// "sol" first, then the longest shared name prefix, then the newest), so the
// hub handles it like its predecessor, and takes the name and description from
// the account's entry. Without a sibling it uses the entry's own metadata.
func codexAccountModelInfo(slug string, entry map[string]any, siblings []*ModelInfo) *ModelInfo {
	displayName, _ := entry["display_name"].(string)
	description, _ := entry["description"].(string)

	if template := closestCodexSibling(slug, siblings); template != nil {
		info := cloneModelInfo(template)
		info.ID = slug
		info.DisplayName = strings.TrimSpace(displayName)
		info.Description = strings.TrimSpace(description)
		info.Version = ""
		info.Name = ""
		info.MetadataModelID = ""
		info.UserDefined = false
		return info
	}

	info := &ModelInfo{
		ID:                        slug,
		Object:                    "model",
		OwnedBy:                   "openai",
		Type:                      "openai",
		DisplayName:               strings.TrimSpace(displayName),
		Description:               strings.TrimSpace(description),
		SupportedOutputModalities: []string{"text"},
	}
	if contextWindow, ok := entry["context_window"].(float64); ok && contextWindow > 0 {
		info.ContextLength = int(contextWindow)
	}
	if levels := CodexClientEntryThinkingLevels(entry); len(levels) > 0 {
		info.Thinking = &ThinkingSupport{Levels: levels}
	}
	if rawModalities, ok := entry["input_modalities"].([]any); ok {
		for _, raw := range rawModalities {
			if modality, okString := raw.(string); okString && strings.TrimSpace(modality) != "" {
				info.SupportedInputModalities = append(info.SupportedInputModalities, strings.TrimSpace(modality))
			}
		}
	}
	return info
}

// CodexClientEntryThinkingLevels returns the reasoning efforts a Codex client
// model entry lists.
func CodexClientEntryThinkingLevels(entry map[string]any) []string {
	rawLevels, ok := entry["supported_reasoning_levels"].([]any)
	if !ok {
		return nil
	}
	levels := make([]string, 0, len(rawLevels))
	for _, rawLevel := range rawLevels {
		if level, okMap := rawLevel.(map[string]any); okMap {
			if effort, okEffort := level["effort"].(string); okEffort && strings.TrimSpace(effort) != "" {
				levels = append(levels, strings.TrimSpace(effort))
			}
		}
	}
	return levels
}

func closestCodexSibling(slug string, candidates []*ModelInfo) *ModelInfo {
	name := lastPathSegment(slug)
	variant := codexModelVariant(name)
	family := ModelFamily(slug)
	var best *ModelInfo
	bestVariant, bestPrefix := false, 0
	for _, candidate := range candidates {
		if candidate == nil || candidate.ID == "" || strings.EqualFold(candidate.ID, slug) || ModelFamily(candidate.ID) != family {
			continue
		}
		candidateName := lastPathSegment(candidate.ID)
		sameVariant := variant != "" && codexModelVariant(candidateName) == variant
		prefix := commonPrefixLength(candidateName, name)
		if prefix == 0 {
			continue
		}
		better := best == nil ||
			(sameVariant && !bestVariant) ||
			(sameVariant == bestVariant && prefix > bestPrefix) ||
			(sameVariant == bestVariant && prefix == bestPrefix && candidate.Created > best.Created)
		if better {
			best, bestVariant, bestPrefix = candidate, sameVariant, prefix
		}
	}
	return best
}

// codexModelVariant returns the word after the last '-' of a versioned model
// name ("sol" for gpt-6.2-sol), or "" when the name has no such word.
func codexModelVariant(name string) string {
	dash := strings.LastIndexByte(name, '-')
	if dash < 0 || dash == len(name)-1 {
		return ""
	}
	variant := name[dash+1:]
	for _, r := range variant {
		if r < 'a' || r > 'z' {
			return ""
		}
	}
	return variant
}

// CodexAccountModelDiscoveryEnabled reports whether the service should ask
// Codex accounts for their models. It is off in Home mode, where the control
// plane owns the catalog, and with --local-model, which pins the catalogs to
// the embedded copies.
func CodexAccountModelDiscoveryEnabled() bool {
	catalogRuntime.Lock()
	defer catalogRuntime.Unlock()
	if catalogRuntime.home {
		return false
	}
	source := effectiveCatalogSources(catalogRuntime.sources, catalogRuntime.local, catalogRuntime.home).CodexCatalog
	return source != embeddedCatalogSource && source != "disabled"
}

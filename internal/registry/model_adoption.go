package registry

import (
	"sort"
	"strings"
	"sync"
	"unicode"
)

// Model adoption lets a request for a model no credential lists yet reach the
// provider it belongs to instead of failing with "unknown provider". Clients
// such as Claude Code, the Gemini CLI, OpenCode and Vibe ship their own model
// lists, which often run ahead of the hub's catalogs. The upstream keeps the
// final word: a name it does not serve fails there with its own error.
//
// The owning provider comes from, in order:
//   - the provider scope of the request (/provider/<name>/...);
//   - a "<prefix>/" in the name, matched against credential prefixes and the
//     namespaced IDs a provider serves (vibe/..., devin/...);
//   - the model family, the name's first word (claude, gpt, gemini, grok,
//     mistral, ...): the providers serving the most models of that family,
//     with a built-in table for families no credential serves a model of yet.

// staticModelFamilyProviders is the fallback for families the registry has no
// model of, keyed by family word.
var staticModelFamilyProviders = map[string][]string{
	"claude":  {"claude"},
	"gpt":     {"codex"},
	"codex":   {"codex"},
	"o1":      {"codex"},
	"o3":      {"codex"},
	"o4":      {"codex"},
	"gemini":  {"gemini", "gemini-interactions", "vertex", "aistudio", "antigravity"},
	"grok":    {"xai"},
	"kimi":    {"kimi"},
	"muse":    {"meta"},
	"swe":     {"devin"},
	"mistral": {"mistral"},
}

// ModelFamily returns the family word of a model ID: the lowercased text before
// the first '-', '.', '_' or ':' of its last path segment.
func ModelFamily(modelID string) string {
	modelID = strings.ToLower(strings.TrimSpace(modelID))
	if slash := strings.LastIndexByte(modelID, '/'); slash >= 0 {
		modelID = modelID[slash+1:]
	}
	if end := strings.IndexAny(modelID, "-._:"); end >= 0 {
		modelID = modelID[:end]
	}
	return modelID
}

// IsAdoptableModelID rejects only names that cannot be a model ID at all: empty
// ones and ones containing whitespace or control characters.
func IsAdoptableModelID(modelID string) bool {
	if strings.TrimSpace(modelID) == "" || modelID == "auto" {
		return false
	}
	for _, r := range modelID {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// FamilyProviders returns the providers that own the family of modelID: those
// serving the most distinct models of that family (namespaced IDs such as
// devin/... are left out), or the built-in table when none serves one.
func (r *ModelRegistry) FamilyProviders(modelID string) []string {
	family := ModelFamily(modelID)
	if family == "" {
		return nil
	}
	counts := make(map[string]int)
	r.mutex.RLock()
	for id, registration := range r.models {
		if registration == nil || strings.Contains(id, "/") || ModelFamily(id) != family {
			continue
		}
		for provider, clients := range registration.Providers {
			if clients > 0 {
				counts[provider]++
			}
		}
	}
	r.mutex.RUnlock()

	best := 0
	for _, count := range counts {
		best = max(best, count)
	}
	if best == 0 {
		return append([]string(nil), staticModelFamilyProviders[family]...)
	}
	var providers []string
	for provider, count := range counts {
		if count == best {
			providers = append(providers, provider)
		}
	}
	return providers
}

// NamespaceProviders returns the providers serving IDs that start with
// "<namespace>/", such as devin/swe-2.
func (r *ModelRegistry) NamespaceProviders(namespace string) []string {
	prefix := strings.ToLower(strings.TrimSpace(namespace)) + "/"
	seen := make(map[string]struct{})
	var providers []string
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	for id, registration := range r.models {
		if registration == nil || !strings.HasPrefix(strings.ToLower(id), prefix) {
			continue
		}
		for provider, clients := range registration.Providers {
			if _, ok := seen[provider]; clients > 0 && !ok {
				seen[provider] = struct{}{}
				providers = append(providers, provider)
			}
		}
	}
	return providers
}

// RegisteredModel is one model with the providers that have a credential for it.
type RegisteredModel struct {
	Info      *ModelInfo
	Providers []string
}

// RegisteredModels returns every model at least one credential registered,
// including ones on a quota cooldown, sorted by ID. Catalogs that clients cache
// (OpenCode's) use it so a model does not vanish while its accounts cool down.
func (r *ModelRegistry) RegisteredModels() []RegisteredModel {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	out := make([]RegisteredModel, 0, len(r.models))
	for _, registration := range r.models {
		if registration == nil || registration.Info == nil || registration.Count <= 0 {
			continue
		}
		var providers []string
		for provider, clients := range registration.Providers {
			if clients > 0 {
				providers = append(providers, provider)
			}
		}
		if len(providers) == 0 {
			continue
		}
		sort.Strings(providers)
		out = append(out, RegisteredModel{Info: cloneModelInfo(registration.Info), Providers: providers})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Info.ID < out[j].Info.ID })
	return out
}

// GetClientProvider returns the provider key a credential registered under, or
// "" when it has no registration.
func (r *ModelRegistry) GetClientProvider(clientID string) string {
	r.mutex.RLock()
	defer r.mutex.RUnlock()
	return r.clientProviders[clientID]
}

// AdoptedModelInfo builds the registration for an adopted model from what the
// registry and the provider's catalog know: it copies the capabilities of the
// model sharing the longest name prefix with modelID (the newest one on a tie),
// so thinking levels, context size and modalities match the closest sibling.
func AdoptedModelInfo(modelID, provider string) *ModelInfo {
	candidates := GetGlobalRegistry().GetAvailableModelsByProvider(provider)
	candidates = append(candidates, GetStaticModelDefinitionsByChannel(provider)...)
	lowerID := lastPathSegment(modelID)
	var template *ModelInfo
	bestPrefix := 0
	for _, candidate := range candidates {
		if candidate == nil || candidate.ID == "" || strings.EqualFold(candidate.ID, modelID) {
			continue
		}
		shared := commonPrefixLength(lastPathSegment(candidate.ID), lowerID)
		if shared == 0 || ModelFamily(candidate.ID) != ModelFamily(modelID) {
			continue
		}
		if template == nil || shared > bestPrefix || (shared == bestPrefix && candidate.Created > template.Created) {
			template = candidate
			bestPrefix = shared
		}
	}
	if template == nil {
		// Nothing to copy: pass thinking settings through unchanged, like a
		// model defined in the config, so the upstream decides what it accepts.
		return &ModelInfo{ID: modelID, Object: "model", OwnedBy: provider, Type: provider, UserDefined: true}
	}
	info := cloneModelInfo(template)
	info.ID = modelID
	info.DisplayName = ""
	info.Description = ""
	info.Version = ""
	info.MetadataModelID = ""
	if strings.HasPrefix(info.Name, "models/") {
		info.Name = "models/" + modelID
	} else {
		info.Name = ""
	}
	return info
}

// lastPathSegment lowercases id and drops any "<prefix>/" before the model name.
func lastPathSegment(id string) string {
	id = strings.ToLower(id)
	if slash := strings.LastIndexByte(id, '/'); slash >= 0 {
		return id[slash+1:]
	}
	return id
}

func commonPrefixLength(a, b string) int {
	n := min(len(a), len(b))
	for i := 0; i < n; i++ {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}

var (
	unknownModelResolverMu sync.RWMutex
	unknownModelResolver   func(modelID, scope string) bool
)

// SetUnknownModelResolver installs the callback that adopts a model nothing
// serves yet. scope is the request's provider scope, or "". The callback
// reports whether a credential now serves the model. nil removes it.
func SetUnknownModelResolver(resolver func(modelID, scope string) bool) {
	unknownModelResolverMu.Lock()
	unknownModelResolver = resolver
	unknownModelResolverMu.Unlock()
}

// ResolveUnknownModel asks the installed resolver to adopt modelID. It returns
// false when no resolver is installed or the name cannot be a model ID.
func ResolveUnknownModel(modelID, scope string) bool {
	modelID = strings.TrimSpace(modelID)
	if !IsAdoptableModelID(modelID) {
		return false
	}
	unknownModelResolverMu.RLock()
	resolver := unknownModelResolver
	unknownModelResolverMu.RUnlock()
	if resolver == nil {
		return false
	}
	return resolver(modelID, strings.ToLower(strings.TrimSpace(scope)))
}

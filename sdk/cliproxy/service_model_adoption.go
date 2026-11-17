package cliproxy

import (
	"sort"
	"strings"
	"sync"

	"github.com/rune-oai/t3code-proxy/internal/registry"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// adoptionKey groups credentials that register the same model list: one
// registry provider key and one credential prefix.
type adoptionKey struct {
	provider string
	prefix   string
}

func newAdoptionKey(provider, prefix string) adoptionKey {
	return adoptionKey{provider: strings.ToLower(strings.TrimSpace(provider)), prefix: strings.TrimSpace(prefix)}
}

// adoptedModelSet records models requested before any catalog listed them.
// Every registration path appends them for its credential, so they survive
// catalog refreshes, token refreshes and re-registration, reach credentials
// added later, and still honor excluded-models settings. There is no cap.
type adoptedModelSet struct {
	// adoptMu serializes adoption so concurrent first requests for one model
	// wait for the registration instead of failing.
	adoptMu sync.Mutex
	mu      sync.RWMutex
	models  map[adoptionKey]map[string]*ModelInfo
}

// add records modelID under key and reports whether it is new.
func (set *adoptedModelSet) add(key adoptionKey, modelID string) bool {
	set.mu.Lock()
	defer set.mu.Unlock()
	if _, exists := set.models[key][modelID]; exists {
		return false
	}
	if set.models == nil {
		set.models = make(map[adoptionKey]map[string]*ModelInfo)
	}
	if set.models[key] == nil {
		set.models[key] = make(map[string]*ModelInfo)
	}
	set.models[key][modelID] = registry.AdoptedModelInfo(modelID, key.provider)
	return true
}

// forKey returns copies of the models adopted under key, sorted by ID.
func (set *adoptedModelSet) forKey(key adoptionKey) []*ModelInfo {
	set.mu.RLock()
	defer set.mu.RUnlock()
	adopted := set.models[key]
	if len(adopted) == 0 {
		return nil
	}
	out := make([]*ModelInfo, 0, len(adopted))
	for _, model := range adopted {
		clone := *model
		out = append(out, &clone)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

type adoptionTarget struct {
	auth    *coreauth.Auth
	key     adoptionKey
	modelID string
}

// adoptUnknownModel registers modelID on the credentials of the provider it
// belongs to (see internal/registry/model_adoption.go for how that provider is
// found). scope limits adoption to one provider. It reports whether a
// credential in scope now serves the model.
func (s *Service) adoptUnknownModel(modelID, scope string) bool {
	if s == nil || s.coreManager == nil {
		return false
	}
	s.adoptedModels.adoptMu.Lock()
	defer s.adoptedModels.adoptMu.Unlock()
	if modelServedInScope(modelID, scope) {
		return true
	}

	targets := s.adoptionTargets(modelID, scope)
	added := false
	for _, target := range targets {
		if s.adoptedModels.add(target.key, target.modelID) {
			added = true
		}
	}
	// Already adopted yet still unserved means excluded-models settings keep it
	// out; registering again would not change that.
	if !added {
		return false
	}
	refreshed := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		if _, done := refreshed[target.auth.ID]; done {
			continue
		}
		refreshed[target.auth.ID] = struct{}{}
		s.refreshModelRegistrationForAuth(target.auth)
	}
	served := modelServedInScope(modelID, scope)
	if served {
		log.WithFields(log.Fields{"model": modelID, "scope": scope, "credentials": len(refreshed)}).Info("adopted a model missing from the catalog")
	}
	return served
}

func modelServedInScope(modelID, scope string) bool {
	for _, provider := range registry.GetGlobalRegistry().GetModelProviders(modelID) {
		if scope == "" || strings.EqualFold(provider, scope) {
			return true
		}
	}
	return false
}

// adoptionTargets lists the credentials that should serve modelID and the ID
// each one registers before its own prefix is applied.
func (s *Service) adoptionTargets(modelID, scope string) []adoptionTarget {
	reg := registry.GetGlobalRegistry()
	cfg := s.currentConfig()
	forcePrefix := cfg != nil && cfg.ForceModelPrefix

	type candidate struct {
		auth     *coreauth.Auth
		provider string
	}
	var candidates []candidate
	for _, item := range s.coreManager.List() {
		if item == nil || item.ID == "" {
			continue
		}
		auth, ok := s.coreManager.GetByID(item.ID)
		if !ok || auth == nil || auth.Disabled {
			continue
		}
		provider := reg.GetClientProvider(auth.ID)
		if provider == "" {
			provider = strings.ToLower(strings.TrimSpace(auth.Provider))
		}
		if scope != "" && !strings.EqualFold(provider, scope) {
			continue
		}
		candidates = append(candidates, candidate{auth: auth, provider: provider})
	}

	var targets []adoptionTarget
	if slash := strings.IndexByte(modelID, '/'); slash > 0 && slash < len(modelID)-1 {
		namespace, base := modelID[:slash], modelID[slash+1:]
		// "<prefix>/<model>" names the credentials registered with that prefix.
		for _, c := range candidates {
			if strings.EqualFold(strings.TrimSpace(c.auth.Prefix), namespace) {
				targets = append(targets, adoptionTarget{auth: c.auth, key: newAdoptionKey(c.provider, c.auth.Prefix), modelID: base})
			}
		}
		if len(targets) > 0 {
			return targets
		}
		// Otherwise the namespace is part of the provider's own IDs (devin/...).
		owners := make(map[string]bool)
		for _, provider := range reg.NamespaceProviders(namespace) {
			owners[provider] = true
		}
		for _, c := range candidates {
			if owners[c.provider] {
				targets = append(targets, adoptionTarget{auth: c.auth, key: newAdoptionKey(c.provider, c.auth.Prefix), modelID: modelID})
			}
		}
		return targets
	}

	owners := make(map[string]bool)
	if scope != "" {
		owners[scope] = true
	} else {
		for _, provider := range reg.FamilyProviders(modelID) {
			owners[strings.ToLower(provider)] = true
		}
	}
	for _, c := range candidates {
		if !owners[c.provider] {
			continue
		}
		// A credential whose models are reachable only as "<prefix>/<model>"
		// cannot serve the bare name.
		if forcePrefix && strings.TrimSpace(c.auth.Prefix) != "" {
			continue
		}
		targets = append(targets, adoptionTarget{auth: c.auth, key: newAdoptionKey(c.provider, c.auth.Prefix), modelID: modelID})
	}
	return targets
}

// appendAdoptedModels adds the models adopted for this provider and prefix
// that the credential does not already list and its exclusions allow. It runs
// before the credential's prefix is applied.
func (s *Service) appendAdoptedModels(provider, prefix string, models []*ModelInfo, excluded []string) []*ModelInfo {
	if s == nil {
		return models
	}
	adopted := s.adoptedModels.forKey(newAdoptionKey(provider, prefix))
	if len(adopted) == 0 {
		return models
	}
	present := make(map[string]struct{}, len(models))
	for _, model := range models {
		if model != nil {
			present[strings.TrimSpace(model.ID)] = struct{}{}
		}
	}
	missing := make([]*ModelInfo, 0, len(adopted))
	for _, model := range adopted {
		if _, exists := present[model.ID]; !exists {
			missing = append(missing, model)
		}
	}
	// Never append into the caller's backing array: it may be a shared cache.
	out := make([]*ModelInfo, 0, len(models)+len(missing))
	out = append(out, models...)
	return append(out, applyExcludedModels(missing, excluded)...)
}

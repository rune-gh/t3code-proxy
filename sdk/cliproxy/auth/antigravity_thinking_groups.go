package auth

import (
	"context"
	"encoding/json"
	"maps"
	"net/url"
	"strings"
	"sync"

	"github.com/rune-oai/t3code-proxy/internal/antigravitycatalog"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/modelconfig"
)

const (
	antigravityThinkingDefaultEndpoint = "https://daily-cloudcode-pa.googleapis.com"
	antigravityThinkingHintsMetaKey    = "antigravity_capability_hints"
	antigravityThinkingMaxIDBytes      = 256
)

type antigravityThinkingGroupsEntry struct {
	epoch     uint64
	project   string
	endpoint  string
	groups    map[string]map[string]int
	webSearch map[string]bool
}

var (
	antigravityThinkingGroupsMu    sync.RWMutex
	antigravityThinkingGroupsStore = make(map[string]antigravityThinkingGroupsEntry)
)

// AntigravityModelSelection holds an upstream model and its metadata for one attempt.
// A positive MaxOutputTokens indicates a match in the account's thinking groups.
type AntigravityModelSelection struct {
	ID              string
	MaxOutputTokens int
	WebSearch       bool
}

// StoreAntigravityThinkingGroups caches parsed fetchAvailableModels grouped thinking
// variants and per-variant web search flags for auth.
func StoreAntigravityThinkingGroups(auth *Auth, groups map[string]map[string]int, webSearch map[string]bool) {
	if auth == nil || strings.TrimSpace(auth.ID) == "" {
		return
	}
	clonedGroups := cloneAntigravityThinkingGroups(groups)
	clonedWS := maps.Clone(webSearch)
	entry := antigravityThinkingGroupsEntry{
		epoch:     auth.RegistrationEpoch,
		project:   antigravityAuthProjectID(auth),
		endpoint:  antigravityAuthEndpoint(auth),
		groups:    clonedGroups,
		webSearch: clonedWS,
	}
	antigravityThinkingGroupsMu.Lock()
	antigravityThinkingGroupsStore[auth.ID] = entry
	antigravityThinkingGroupsMu.Unlock()
}

// ClearAntigravityThinkingGroups removes cached thinking groups for an unregistered auth.
func ClearAntigravityThinkingGroups(authID string) {
	if strings.TrimSpace(authID) == "" {
		return
	}
	antigravityThinkingGroupsMu.Lock()
	delete(antigravityThinkingGroupsStore, authID)
	antigravityThinkingGroupsMu.Unlock()
}

// SelectAntigravityModel resolves a thinking variant from the credential-scoped
// catalog snapshot. An empty or unmatched level keeps the original ID.
func SelectAntigravityModel(_ context.Context, auth *Auth, upstreamModelID, level string, cfg *config.Config) AntigravityModelSelection {
	selection := AntigravityModelSelection{ID: upstreamModelID}
	if auth == nil || upstreamModelID == "" || len(upstreamModelID) > antigravityThinkingMaxIDBytes {
		return selection
	}
	level = strings.ToLower(strings.TrimSpace(level))
	if level == "" || !antigravitycatalog.ValidThinkingSuffix(level) {
		return selection
	}
	groups, webSearch := lookupAntigravityThinkingGroups(auth)
	if len(groups) == 0 {
		return selection
	}
	selection.selectThinkingVariant(level, AntigravityExcludedModels(auth, cfg), func(group, lvl string) (int, bool) {
		levels, isGroup := groups[group]
		if limit, listed := levels[lvl]; listed && limit >= 0 {
			return limit, true
		}
		return -1, isGroup
	})
	if selection.MaxOutputTokens > 0 {
		selection.WebSearch = webSearch[selection.ID]
	}
	return selection
}

// AntigravityExcludedModels returns the effective OAuth exclusion patterns.
func AntigravityExcludedModels(auth *Auth, cfg *config.Config) []string {
	if auth == nil {
		return nil
	}
	if value := strings.TrimSpace(auth.Attributes["excluded_models"]); value != "" {
		return strings.Split(value, ",")
	}
	if cfg != nil {
		return cfg.OAuthExcludedModels[OAuthModelAliasChannel(auth.Provider, auth.AuthKind())]
	}
	return nil
}

// SameAntigravityModelCatalogScope checks whether an access-token refresh can
// reuse the selection and exclusion decision from the original credential.
func SameAntigravityModelCatalogScope(before, after *Auth) bool {
	if before == nil || after == nil || strings.TrimSpace(before.ID) == "" || before.ID != after.ID {
		return false
	}
	return before.RegistrationEpoch == after.RegistrationEpoch &&
		before.AuthKind() == after.AuthKind() &&
		before.Attributes["excluded_models"] == after.Attributes["excluded_models"] &&
		antigravityAuthProjectID(before) == antigravityAuthProjectID(after) &&
		antigravityAuthEndpoint(before) == antigravityAuthEndpoint(after)
}

// lookupLimit returns -1 for a missing or malformed member and zero for a
// declared member that cannot serve as a target.
func (selection *AntigravityModelSelection) selectThinkingVariant(level string, excluded []string, lookupLimit func(group, level string) (int, bool)) {
	group := selection.ID
	limit, isGroup := lookupLimit(group, level)
	if !isGroup {
		// Try the longest group first. A shared prefix is not evidence of
		// membership; the complete suffix must be listed in that group.
		for end := len(selection.ID); end > 0; {
			end = strings.LastIndexByte(selection.ID[:end], '-')
			if end <= 0 {
				break
			}
			group = selection.ID[:end]
			suffix := selection.ID[end+1:]
			if !antigravitycatalog.ValidThinkingSuffix(suffix) {
				continue
			}
			if current, _ := lookupLimit(group, suffix); current >= 0 {
				limit, _ = lookupLimit(group, level)
				break
			}
		}
	}
	if limit <= 0 || len(group)+1+len(level) > antigravityThinkingMaxIDBytes {
		return
	}
	target := group + "-" + level
	normalized := strings.ToLower(strings.TrimSpace(target))
	for _, pattern := range excluded {
		if modelconfig.MatchExcludedModelPattern(strings.ToLower(strings.TrimSpace(pattern)), normalized) {
			return
		}
	}
	selection.ID, selection.MaxOutputTokens = target, limit
}

func lookupAntigravityThinkingGroups(auth *Auth) (map[string]map[string]int, map[string]bool) {
	project := antigravityAuthProjectID(auth)
	endpoint := antigravityAuthEndpoint(auth)
	if auth.ID != "" {
		antigravityThinkingGroupsMu.RLock()
		entry, ok := antigravityThinkingGroupsStore[auth.ID]
		antigravityThinkingGroupsMu.RUnlock()
		if ok && entry.epoch == auth.RegistrationEpoch && entry.project == project && entry.endpoint == endpoint {
			return entry.groups, entry.webSearch
		}
	}
	return antigravityThinkingGroupsFromMetadata(auth.Metadata, project, endpoint)
}

func antigravityThinkingGroupsFromMetadata(metadata map[string]any, expectedProject, expectedEndpoint string) (map[string]map[string]int, map[string]bool) {
	if metadata == nil {
		return nil, nil
	}
	raw, ok := metadata[antigravityThinkingHintsMetaKey]
	if !ok || raw == nil {
		return nil, nil
	}
	rawMap, ok := raw.(map[string]any)
	if !ok {
		return nil, nil
	}
	persistedProject, _ := rawMap["project_id"].(string)
	persistedEndpoint, _ := rawMap["endpoint"].(string)
	if strings.TrimSpace(persistedProject) != expectedProject {
		return nil, nil
	}
	if sanitizeAntigravityEndpoint(persistedEndpoint) != expectedEndpoint {
		return nil, nil
	}
	rawGroups, ok := rawMap["thinking_groups"].(map[string]any)
	if !ok || len(rawGroups) == 0 {
		return nil, nil
	}
	groups := make(map[string]map[string]int, len(rawGroups))
	for group, rawLevels := range rawGroups {
		if group == "" || len(group) >= antigravityThinkingMaxIDBytes {
			continue
		}
		levelsMap, okLevels := rawLevels.(map[string]any)
		if !okLevels {
			continue
		}
		levels := make(map[string]int, len(levelsMap))
		for level, rawLimit := range levelsMap {
			normalizedLevel := strings.ToLower(strings.TrimSpace(level))
			if normalizedLevel == "" || len(group)+1+len(normalizedLevel) > antigravityThinkingMaxIDBytes || !antigravitycatalog.ValidThinkingSuffix(normalizedLevel) {
				continue
			}
			limit, okLimit := antigravityNonNegativeInt(rawLimit)
			if !okLimit {
				continue
			}
			levels[normalizedLevel] = limit
		}
		if len(levels) > 0 {
			groups[group] = levels
		}
	}
	if len(groups) == 0 {
		return nil, nil
	}
	var webSearch map[string]bool
	if rawWS := rawMap["thinking_web_search"]; rawWS != nil {
		switch items := rawWS.(type) {
		case []any:
			webSearch = make(map[string]bool, len(items))
			for _, item := range items {
				if s, okStr := item.(string); okStr && s != "" {
					webSearch[s] = true
				}
			}
		case []string:
			webSearch = make(map[string]bool, len(items))
			for _, s := range items {
				if s != "" {
					webSearch[s] = true
				}
			}
		case map[string]bool:
			webSearch = maps.Clone(items)
		case map[string]any:
			webSearch = make(map[string]bool, len(items))
			for id, rawVal := range items {
				if val, okBool := rawVal.(bool); okBool && val && id != "" {
					webSearch[id] = true
				}
			}
		}
	}
	return groups, webSearch
}

func antigravityNonNegativeInt(raw any) (int, bool) {
	switch v := raw.(type) {
	case int:
		return v, v >= 0
	case int64:
		return int(v), v >= 0
	case float64:
		if v < 0 || v != float64(int(v)) {
			return 0, false
		}
		return int(v), true
	case json.Number:
		n, err := v.Int64()
		if err != nil || n < 0 {
			return 0, false
		}
		return int(n), true
	default:
		return 0, false
	}
}

func cloneAntigravityThinkingGroups(groups map[string]map[string]int) map[string]map[string]int {
	if len(groups) == 0 {
		return nil
	}
	cloned := make(map[string]map[string]int, len(groups))
	for group, levels := range groups {
		cloned[group] = maps.Clone(levels)
	}
	return cloned
}

func antigravityAuthProjectID(auth *Auth) string {
	if auth == nil || auth.Metadata == nil {
		return ""
	}
	project, _ := auth.Metadata["project_id"].(string)
	return strings.TrimSpace(project)
}

func antigravityAuthEndpoint(auth *Auth) string {
	if auth != nil {
		if auth.Attributes != nil {
			if raw := strings.TrimSpace(auth.Attributes["base_urls"]); raw != "" {
				for _, part := range strings.Split(raw, ",") {
					if trimmed := sanitizeAntigravityEndpoint(part); trimmed != "" {
						return trimmed
					}
				}
			}
			if trimmed := sanitizeAntigravityEndpoint(auth.Attributes["base_url"]); trimmed != "" {
				return trimmed
			}
		}
		if auth.Metadata != nil {
			if raw, ok := auth.Metadata["base_url"].(string); ok {
				if trimmed := sanitizeAntigravityEndpoint(raw); trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return antigravityThinkingDefaultEndpoint
}

func sanitizeAntigravityEndpoint(endpoint string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(endpoint), "/")
	if trimmed == "" {
		return ""
	}
	if parsed, errParse := url.Parse(trimmed); errParse == nil && parsed.User != nil {
		parsed.User = nil
		return strings.TrimRight(parsed.String(), "/")
	}
	return trimmed
}

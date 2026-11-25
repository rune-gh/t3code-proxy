package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/antigravitycatalog"
	"github.com/rune-oai/t3code-proxy/sdk/proxyutil"
	log "github.com/sirupsen/logrus"
)

const (
	// AntigravityModelBaseURLDaily is the default Cloud Code endpoint for Antigravity model discovery.
	AntigravityModelBaseURLDaily = "https://daily-cloudcode-pa.googleapis.com"
	// AntigravityModelsPath is the upstream path for per-account model capability discovery.
	AntigravityModelsPath = "/v1internal:fetchAvailableModels"
	// AntigravityPersistedHintsMetaKey is the auth metadata key storing persisted model capability hints.
	AntigravityPersistedHintsMetaKey = "antigravity_capability_hints"

	antigravityMaxCatalogModels = 1024
	antigravityMaxModelIDBytes  = 256
)

// AntigravityProbeStatus classifies the outcome of an Antigravity model discovery request.
type AntigravityProbeStatus int

const (
	AntigravityProbeStatusSuccess AntigravityProbeStatus = iota
	AntigravityProbeStatusAuthError
	AntigravityProbeStatusTransientError
)

// AntigravityModelCapabilityHints holds normalized per-account model IDs and web-search capability IDs.
type AntigravityModelCapabilityHints struct {
	WebSearchModelIDs map[string]struct{}
	// Nil means unknown; an empty non-nil set is an authoritative empty catalog.
	ModelIDs map[string]struct{}
	// ThinkingGroups maps catalog group IDs and declared variant suffixes to output token limits.
	ThinkingGroups map[string]map[string]int
	// ThinkingWebSearch contains only grouped upstream IDs that advertise web search.
	ThinkingWebSearch map[string]bool
}

// Clone returns a deep copy of the capability hints.
func (h AntigravityModelCapabilityHints) Clone() AntigravityModelCapabilityHints {
	groups := maps.Clone(h.ThinkingGroups)
	for group, levels := range groups {
		groups[group] = maps.Clone(levels)
	}
	return AntigravityModelCapabilityHints{
		WebSearchModelIDs: maps.Clone(h.WebSearchModelIDs),
		ModelIDs:          maps.Clone(h.ModelIDs),
		ThinkingGroups:    groups,
		ThinkingWebSearch: maps.Clone(h.ThinkingWebSearch),
	}
}

// AntigravityModelProbeRequest configures a single-shot fetchAvailableModels probe.
type AntigravityModelProbeRequest struct {
	BaseURLs    []string
	ProxyURL    string
	AccessToken string
	ProjectID   string
	UserAgent   string
}

// FetchAntigravityAvailableModels performs a single-shot POST /v1internal:fetchAvailableModels request
// and parses the returned per-account model catalog and webSearchModelIds.
func FetchAntigravityAvailableModels(ctx context.Context, req AntigravityModelProbeRequest) (AntigravityModelCapabilityHints, AntigravityProbeStatus) {
	baseURL := ""
	for _, candidate := range req.BaseURLs {
		if trimmed := strings.TrimRight(strings.TrimSpace(candidate), "/"); trimmed != "" {
			baseURL = trimmed
			break
		}
	}
	if baseURL == "" {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusTransientError
	}
	accessToken := strings.TrimSpace(req.AccessToken)
	if accessToken == "" {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusAuthError
	}
	if ctx == nil {
		ctx = context.Background()
	}

	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	transport, _, errProxy := proxyutil.BuildHTTPTransport(strings.TrimSpace(req.ProxyURL))
	if errProxy != nil {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusTransientError
	}
	if transport != nil {
		client.Transport = transport
		defer transport.CloseIdleConnections()
	}

	doc := ojson.NewDoc([]byte("{}"))
	doc.Set("project", strings.TrimSpace(req.ProjectID))
	httpReq, errReq := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+AntigravityModelsPath, bytes.NewReader(doc.Bytes()))
	if errReq != nil {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusTransientError
	}
	userAgent := strings.TrimSpace(req.UserAgent)
	if userAgent == "" {
		userAgent = AntigravityUserAgent()
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+accessToken)
	httpReq.Header.Set("User-Agent", userAgent)

	resp, errDo := client.Do(httpReq)
	if errDo != nil {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusTransientError
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.Debug("antigravity model fetch: response close failed")
		}
	}()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusAuthError
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusTransientError
	}
	const maxCatalogBytes = 8 << 20
	data, errRead := io.ReadAll(io.LimitReader(resp.Body, maxCatalogBytes+1))
	if errRead != nil || len(data) > maxCatalogBytes {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusTransientError
	}
	hints, ok := ParseAntigravityModelCapabilityHints(data)
	if !ok {
		return AntigravityModelCapabilityHints{}, AntigravityProbeStatusTransientError
	}
	return hints, AntigravityProbeStatusSuccess
}

// NormalizeAntigravityModelID normalizes an Antigravity model identifier for case-insensitive matching.
func NormalizeAntigravityModelID(modelID string) string {
	trimmed := strings.ToLower(strings.TrimSpace(modelID))
	if len(trimmed) > antigravityMaxModelIDBytes {
		return ""
	}
	return strings.Clone(trimmed)
}

func sanitizeAntigravityPersistedEndpoint(endpoint string) string {
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

// ParseAntigravityModelCapabilityHints decodes a fetchAvailableModels response payload using ojson.
func ParseAntigravityModelCapabilityHints(body []byte) (AntigravityModelCapabilityHints, bool) {
	if len(body) == 0 || !ojson.ValidBytes(body) {
		return AntigravityModelCapabilityHints{}, false
	}
	top := ojson.ParseBytes(body)
	if !top.IsObject() {
		return AntigravityModelCapabilityHints{}, false
	}

	webSearchResult := top.Get("webSearchModelIds")
	webSearchModels := make(map[string]struct{})
	var webSearchItems []ojson.Result
	if webSearchResult.Exists() && webSearchResult.Type != ojson.Null {
		if !webSearchResult.IsArray() {
			return AntigravityModelCapabilityHints{}, false
		}
		webSearchItems = webSearchResult.Array()
		if len(webSearchItems) > antigravityMaxCatalogModels {
			return AntigravityModelCapabilityHints{}, false
		}
		for _, item := range webSearchItems {
			if item.Type != ojson.String {
				return AntigravityModelCapabilityHints{}, false
			}
			if normalized := NormalizeAntigravityModelID(item.Str); normalized != "" {
				webSearchModels[normalized] = struct{}{}
			}
		}
	}

	modelsResult := top.Get("models")
	var modelIDs map[string]struct{}
	var thinkingGroups map[string]map[string]int
	if modelsResult.Exists() && modelsResult.Type != ojson.Null {
		if !modelsResult.IsObject() {
			return AntigravityModelCapabilityHints{}, false
		}
		modelMap := modelsResult.Map()
		if len(modelMap) > antigravityMaxCatalogModels {
			return AntigravityModelCapabilityHints{}, false
		}
		modelIDs = make(map[string]struct{}, len(modelMap))
		for id := range modelMap {
			if normalized := NormalizeAntigravityModelID(id); normalized != "" {
				modelIDs[normalized] = struct{}{}
			}
		}
		thinkingGroups = parseAntigravityThinkingGroups(top.Get("groupedModels"), modelMap)
	}

	return AntigravityModelCapabilityHints{
		WebSearchModelIDs: webSearchModels,
		ModelIDs:          modelIDs,
		ThinkingGroups:    thinkingGroups,
		ThinkingWebSearch: antigravityThinkingWebSearch(thinkingGroups, webSearchItems),
	}, true
}

func antigravityThinkingWebSearch(groups map[string]map[string]int, items []ojson.Result) map[string]bool {
	if len(groups) == 0 || len(items) == 0 {
		return nil
	}
	// Grouped variants use exact upstream IDs, unlike registration hints.
	declared := make(map[string]struct{}, len(items))
	for _, item := range items {
		declared[item.Str] = struct{}{}
	}
	var supported map[string]bool
	for group, levels := range groups {
		for level := range levels {
			id := group + "-" + level
			if _, ok := declared[id]; ok {
				if supported == nil {
					supported = make(map[string]bool)
				}
				supported[id] = true
			}
		}
	}
	return supported
}

func parseAntigravityThinkingGroups(groupedModels ojson.Result, models map[string]ojson.Result) map[string]map[string]int {
	if !groupedModels.IsObject() || len(models) == 0 {
		return nil
	}
	var groups map[string]map[string]int
	groupedModels.ForEach(func(key, entry ojson.Result) bool {
		group := key.Str
		if group == "" || len(group) >= antigravityMaxModelIDBytes || !entry.IsObject() {
			return true
		}
		declared := entry.Get("supportedThinkingLevels")
		if !declared.IsArray() {
			return true
		}
		var levels map[string]int
		declared.ForEach(func(_, item ojson.Result) bool {
			if !item.IsObject() {
				return true
			}
			suffix := item.Get("thinkingSuffix")
			if suffix.Type != ojson.String || len(group)+1+len(suffix.Str) > antigravityMaxModelIDBytes || !antigravitycatalog.ValidThinkingSuffix(suffix.Str) {
				return true
			}
			level := strings.ToLower(suffix.Str)
			member := models[group+"-"+level]
			if !member.IsObject() {
				return true
			}
			// Zero records a declared member that is not eligible as a switch target.
			limit := 0
			if value := member.Get("maxOutputTokens"); value.Type == ojson.Number {
				if n, errLimit := strconv.Atoi(value.Raw); errLimit == nil && n > 0 {
					limit = n
				}
			}
			if levels == nil {
				levels = make(map[string]int)
			}
			levels[strings.Clone(level)] = limit
			return true
		})
		if len(levels) > 0 {
			if groups == nil {
				groups = make(map[string]map[string]int)
			}
			groups[strings.Clone(group)] = levels
		}
		return true
	})
	return groups
}

// BuildPersistedAntigravityCapabilityHints serializes capability hints for storage in auth metadata.
// It returns nil when hints.ModelIDs is nil so unknown catalogs are never persisted as authoritative empty sets.
func BuildPersistedAntigravityCapabilityHints(project, endpoint string, hints AntigravityModelCapabilityHints) map[string]any {
	if hints.ModelIDs == nil {
		return nil
	}
	modelIDs := make([]string, 0, len(hints.ModelIDs))
	for id := range hints.ModelIDs {
		if normalized := NormalizeAntigravityModelID(id); normalized != "" {
			modelIDs = append(modelIDs, normalized)
		}
	}
	slices.Sort(modelIDs)
	modelItems := make([]any, len(modelIDs))
	for i, id := range modelIDs {
		modelItems[i] = id
	}
	value := map[string]any{
		"model_ids": modelItems,
	}
	if project = strings.TrimSpace(project); project != "" {
		value["project_id"] = project
	}
	if endpoint = sanitizeAntigravityPersistedEndpoint(endpoint); endpoint != "" {
		value["endpoint"] = endpoint
	}
	if len(hints.WebSearchModelIDs) > 0 {
		webSearchIDs := make([]string, 0, len(hints.WebSearchModelIDs))
		for id := range hints.WebSearchModelIDs {
			if normalized := NormalizeAntigravityModelID(id); normalized != "" {
				webSearchIDs = append(webSearchIDs, normalized)
			}
		}
		slices.Sort(webSearchIDs)
		if len(webSearchIDs) > 0 {
			webSearchItems := make([]any, len(webSearchIDs))
			for i, id := range webSearchIDs {
				webSearchItems[i] = id
			}
			value["web_search_model_ids"] = webSearchItems
		}
	}
	if len(hints.ThinkingGroups) > 0 {
		persistedGroups := make(map[string]any, len(hints.ThinkingGroups))
		for group, levels := range hints.ThinkingGroups {
			if group == "" || len(group) >= antigravityMaxModelIDBytes || len(levels) == 0 {
				continue
			}
			persistedLevels := make(map[string]any, len(levels))
			for level, limit := range levels {
				normalizedLevel := strings.ToLower(strings.TrimSpace(level))
				if normalizedLevel == "" || len(group)+1+len(normalizedLevel) > antigravityMaxModelIDBytes || !antigravitycatalog.ValidThinkingSuffix(normalizedLevel) || limit < 0 {
					continue
				}
				persistedLevels[normalizedLevel] = limit
			}
			if len(persistedLevels) > 0 {
				persistedGroups[group] = persistedLevels
			}
		}
		if len(persistedGroups) > 0 {
			value["thinking_groups"] = persistedGroups
		}
	}
	if len(hints.ThinkingWebSearch) > 0 {
		thinkingWebSearchIDs := make([]string, 0, len(hints.ThinkingWebSearch))
		for id, supported := range hints.ThinkingWebSearch {
			if supported && id != "" && len(id) <= antigravityMaxModelIDBytes {
				thinkingWebSearchIDs = append(thinkingWebSearchIDs, id)
			}
		}
		slices.Sort(thinkingWebSearchIDs)
		if len(thinkingWebSearchIDs) > 0 {
			items := make([]any, len(thinkingWebSearchIDs))
			for i, id := range thinkingWebSearchIDs {
				items[i] = id
			}
			value["thinking_web_search"] = items
		}
	}
	return value
}

// ParsePersistedAntigravityCapabilityHints extracts and validates persisted capability hints from auth metadata.
func ParsePersistedAntigravityCapabilityHints(metadata map[string]any, expectedProject, expectedEndpoint string) (AntigravityModelCapabilityHints, bool) {
	if metadata == nil {
		return AntigravityModelCapabilityHints{}, false
	}
	raw, ok := metadata[AntigravityPersistedHintsMetaKey]
	if !ok || raw == nil {
		return AntigravityModelCapabilityHints{}, false
	}
	rawMap, ok := raw.(map[string]any)
	if !ok {
		return AntigravityModelCapabilityHints{}, false
	}
	persistedProject, _ := rawMap["project_id"].(string)
	persistedEndpoint, _ := rawMap["endpoint"].(string)
	if strings.TrimSpace(persistedProject) != strings.TrimSpace(expectedProject) {
		return AntigravityModelCapabilityHints{}, false
	}
	if sanitizeAntigravityPersistedEndpoint(persistedEndpoint) != sanitizeAntigravityPersistedEndpoint(expectedEndpoint) {
		return AntigravityModelCapabilityHints{}, false
	}
	rawModels, hasModels := rawMap["model_ids"]
	if !hasModels || rawModels == nil {
		return AntigravityModelCapabilityHints{}, false
	}
	modelIDs, ok := parsePersistedAntigravityModelSet(rawModels)
	if !ok {
		return AntigravityModelCapabilityHints{}, false
	}
	webSearchModels := make(map[string]struct{})
	if rawWebSearch, hasWebSearch := rawMap["web_search_model_ids"]; hasWebSearch && rawWebSearch != nil {
		parsedWebSearch, okWebSearch := parsePersistedAntigravityModelSet(rawWebSearch)
		if !okWebSearch {
			return AntigravityModelCapabilityHints{}, false
		}
		webSearchModels = parsedWebSearch
	}
	var thinkingGroups map[string]map[string]int
	if rawGroups, hasGroups := rawMap["thinking_groups"]; hasGroups && rawGroups != nil {
		parsedGroups, okGroups := parsePersistedAntigravityThinkingGroups(rawGroups)
		if !okGroups {
			return AntigravityModelCapabilityHints{}, false
		}
		thinkingGroups = parsedGroups
	}
	var thinkingWebSearch map[string]bool
	if rawThinkingWS, hasThinkingWS := rawMap["thinking_web_search"]; hasThinkingWS && rawThinkingWS != nil {
		parsedThinkingWS, okThinkingWS := parsePersistedAntigravityThinkingWebSearch(rawThinkingWS)
		if !okThinkingWS {
			return AntigravityModelCapabilityHints{}, false
		}
		thinkingWebSearch = parsedThinkingWS
	}
	return AntigravityModelCapabilityHints{
		ModelIDs:          modelIDs,
		WebSearchModelIDs: webSearchModels,
		ThinkingGroups:    thinkingGroups,
		ThinkingWebSearch: thinkingWebSearch,
	}, true
}

func parsePersistedAntigravityThinkingGroups(raw any) (map[string]map[string]int, bool) {
	rawGroups, ok := raw.(map[string]any)
	if !ok {
		return nil, false
	}
	if len(rawGroups) == 0 {
		return nil, true
	}
	groups := make(map[string]map[string]int, len(rawGroups))
	for group, rawLevels := range rawGroups {
		if group == "" || len(group) >= antigravityMaxModelIDBytes {
			continue
		}
		levelsMap, okLevels := rawLevels.(map[string]any)
		if !okLevels {
			return nil, false
		}
		levels := make(map[string]int, len(levelsMap))
		for level, rawLimit := range levelsMap {
			normalizedLevel := strings.ToLower(strings.TrimSpace(level))
			if normalizedLevel == "" || len(group)+1+len(normalizedLevel) > antigravityMaxModelIDBytes || !antigravitycatalog.ValidThinkingSuffix(normalizedLevel) {
				continue
			}
			limit, okLimit := parsePersistedNonNegativeInt(rawLimit)
			if !okLimit {
				return nil, false
			}
			levels[strings.Clone(normalizedLevel)] = limit
		}
		if len(levels) > 0 {
			groups[strings.Clone(group)] = levels
		}
	}
	if len(groups) == 0 {
		return nil, true
	}
	return groups, true
}

func parsePersistedAntigravityThinkingWebSearch(raw any) (map[string]bool, bool) {
	switch items := raw.(type) {
	case []any:
		out := make(map[string]bool, len(items))
		for _, item := range items {
			s, ok := item.(string)
			if !ok {
				return nil, false
			}
			if s != "" && len(s) <= antigravityMaxModelIDBytes {
				out[strings.Clone(s)] = true
			}
		}
		return out, true
	case []string:
		out := make(map[string]bool, len(items))
		for _, s := range items {
			if s != "" && len(s) <= antigravityMaxModelIDBytes {
				out[strings.Clone(s)] = true
			}
		}
		return out, true
	case map[string]any:
		out := make(map[string]bool, len(items))
		for id, rawVal := range items {
			val, ok := rawVal.(bool)
			if !ok {
				return nil, false
			}
			if val && id != "" && len(id) <= antigravityMaxModelIDBytes {
				out[strings.Clone(id)] = true
			}
		}
		return out, true
	case map[string]bool:
		out := make(map[string]bool, len(items))
		for id, val := range items {
			if val && id != "" && len(id) <= antigravityMaxModelIDBytes {
				out[strings.Clone(id)] = true
			}
		}
		return out, true
	default:
		return nil, false
	}
}

func parsePersistedNonNegativeInt(raw any) (int, bool) {
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

func parsePersistedAntigravityModelSet(raw any) (map[string]struct{}, bool) {
	switch items := raw.(type) {
	case []any:
		set := make(map[string]struct{}, len(items))
		for _, item := range items {
			s, ok := item.(string)
			if !ok {
				return nil, false
			}
			if normalized := NormalizeAntigravityModelID(s); normalized != "" {
				set[normalized] = struct{}{}
			}
		}
		return set, true
	case []string:
		set := make(map[string]struct{}, len(items))
		for _, s := range items {
			if normalized := NormalizeAntigravityModelID(s); normalized != "" {
				set[normalized] = struct{}{}
			}
		}
		return set, true
	default:
		return nil, false
	}
}

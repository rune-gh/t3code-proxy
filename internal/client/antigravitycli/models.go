package antigravitycli

import (
	"sort"
	"strings"

	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/thinking"
)

// maxCatalogEntries is the maximum number of `/v1beta/models` entries that the
// standalone Antigravity CLI (`agy`) loads in gateway mode before silently
// discarding the remainder. Keeping the expanded catalog within this ceiling
// guarantees no model is dropped and no effort group is truncated mid-group.
const maxCatalogEntries = 32

// supportedLevels lists the thinking effort levels recognized by the standalone
// Antigravity CLI (`agy`) in canonical order. Values outside this set (such as
// "minimal", "none", "auto" or "ultra") are not grouped into `thought_level` by
// `agy` and would instead appear as separate models in the picker.
var supportedLevels = []string{"low", "medium", "high", "xhigh", "max"}

var supportedLevelSet = map[string]struct{}{
	"low":    {},
	"medium": {},
	"high":   {},
	"xhigh":  {},
	"max":    {},
}

// IsAntigravityCLIUserAgent reports whether userAgent identifies the standalone
// Antigravity CLI (`agy`).
func IsAntigravityCLIUserAgent(userAgent string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(userAgent)), "antigravity/cli/")
}

// ResolveLevels returns the Antigravity CLI effort levels supported by support
// in canonical order.
func ResolveLevels(support *registry.ThinkingSupport) []string {
	if support == nil {
		return nil
	}
	if len(support.Levels) > 0 {
		present := make(map[string]struct{}, len(support.Levels))
		for _, raw := range support.Levels {
			level := strings.ToLower(strings.TrimSpace(raw))
			if _, ok := supportedLevelSet[level]; ok {
				present[level] = struct{}{}
			}
		}
		out := make([]string, 0, len(present))
		for _, level := range supportedLevels {
			if _, ok := present[level]; ok {
				out = append(out, level)
			}
		}
		return out
	}

	// Budget-only thinking models (for example claude-opus-4-6-thinking and
	// claude-sonnet-4-6) map discrete effort levels to token budgets inside
	// thinking.ValidateConfig. Derive distinct levels within [Min, Max].
	if support.Min <= 0 && support.Max <= 0 {
		return nil
	}

	type budgetChoice struct {
		level    string
		distance int
	}
	byClamped := make(map[int]budgetChoice, len(supportedLevels))
	clampedOrder := make([]int, 0, len(supportedLevels))
	for _, level := range supportedLevels {
		rawBudget, ok := thinking.ConvertLevelToBudget(level)
		if !ok || rawBudget <= 0 {
			continue
		}
		clamped := rawBudget
		if support.Min > 0 && clamped < support.Min {
			clamped = support.Min
		}
		if support.Max > 0 && clamped > support.Max {
			clamped = support.Max
		}
		dist := rawBudget - clamped
		if dist < 0 {
			dist = -dist
		}
		if prev, exists := byClamped[clamped]; exists {
			if dist < prev.distance {
				byClamped[clamped] = budgetChoice{level: level, distance: dist}
			}
			continue
		}
		byClamped[clamped] = budgetChoice{level: level, distance: dist}
		clampedOrder = append(clampedOrder, clamped)
	}

	out := make([]string, 0, len(clampedOrder))
	for _, clamped := range clampedOrder {
		out = append(out, byClamped[clamped].level)
	}
	return out
}

type modelMember struct {
	info        *registry.ModelInfo
	id          string
	baseID      string
	suffixLevel string
	levels      []string
	hasDisplay  bool
}

type modelGroup struct {
	key              string
	members          []modelMember
	primary          modelMember
	dedicatedByLevel map[string]modelMember
	primaryLevelSet  map[string]struct{}
	availableLevels  []string
	explicitLevels   bool
	flatEntries      []map[string]any
	allocatedSlots   int
	expanded         bool
	levels           []string
	entries          []map[string]any
}

// BuildModels formats available models for Antigravity CLI's `/v1beta/models`
// endpoint so thinking levels appear under the `thought_level` effort selector
// instead of as duplicate or level-suffixed models, while staying within the
// CLI's 32-entry gateway model limit.
func BuildModels(infos []*registry.ModelInfo) []map[string]any {
	return buildModelsWithCap(infos, maxCatalogEntries)
}

func buildModelsWithCap(infos []*registry.ModelInfo, maxEntries int) []map[string]any {
	if len(infos) == 0 {
		return []map[string]any{}
	}

	normalized := make([]*registry.ModelInfo, 0, len(infos))
	byLowerID := make(map[string]*registry.ModelInfo, len(infos))
	for _, info := range infos {
		if info == nil {
			continue
		}
		id := normalizeModelID(info)
		if id == "" {
			continue
		}
		lowerID := strings.ToLower(id)
		if _, dup := byLowerID[lowerID]; dup {
			continue
		}
		byLowerID[lowerID] = info
		normalized = append(normalized, info)
	}
	sort.Slice(normalized, func(i, j int) bool {
		return strings.ToLower(normalizeModelID(normalized[i])) < strings.ToLower(normalizeModelID(normalized[j]))
	})

	groupsByKey := make(map[string]*modelGroup, len(normalized))
	groupOrder := make([]string, 0, len(normalized))
	passthrough := make([]map[string]any, 0)

	for _, info := range normalized {
		id := normalizeModelID(info)
		// Preserve models that already carry an explicit `(suffix)` thinking marker
		// as-is instead of appending a second suffix.
		if parsed := thinking.ParseSuffix(id); parsed.HasSuffix {
			passthrough = append(passthrough, buildGeminiModelMap(info, id, defaultDisplayName(info, id), info.Thinking != nil))
			continue
		}

		baseID, suffixLevel := splitEffortSuffix(id)
		groupKey := strings.ToLower(baseID)

		// Merge a forked alias like `claude-opus-4-6` with its target
		// `claude-opus-4-6-thinking` when they share the same cleaned display name.
		if metaID := normalizeRawID(info.MetadataModelID); metaID != "" {
			if target, ok := byLowerID[strings.ToLower(metaID)]; ok && target != nil {
				targetID := normalizeModelID(target)
				targetBase, _ := splitEffortSuffix(targetID)
				if strings.EqualFold(baseID, targetBase) {
					groupKey = strings.ToLower(targetBase)
				} else if strings.EqualFold(stripTrailingThinkingSegment(targetID), id) &&
					strings.EqualFold(cleanDisplayName(info.DisplayName, id), cleanDisplayName(target.DisplayName, targetID)) {
					groupKey = strings.ToLower(targetBase)
				}
			}
		}

		member := modelMember{
			info:        info,
			id:          id,
			baseID:      baseID,
			suffixLevel: suffixLevel,
			levels:      ResolveLevels(info.Thinking),
			hasDisplay:  strings.TrimSpace(info.DisplayName) != "",
		}
		group := groupsByKey[groupKey]
		if group == nil {
			group = &modelGroup{key: groupKey}
			groupsByKey[groupKey] = group
			groupOrder = append(groupOrder, groupKey)
		}
		group.members = append(group.members, member)
	}

	groups := make([]*modelGroup, 0, len(groupOrder))
	for _, key := range groupOrder {
		group := groupsByKey[key]
		prepareGroup(group)
		groups = append(groups, group)
	}

	allocateSlotBudgets(groups, len(passthrough), maxEntries)

	expandedGroups := make([]*modelGroup, 0, len(groups))
	flatEntries := make([]map[string]any, 0, len(passthrough))

	for _, group := range groups {
		materializeGroupEntries(group)
		if group.expanded {
			expandedGroups = append(expandedGroups, group)
		} else {
			flatEntries = append(flatEntries, group.entries...)
		}
	}
	flatEntries = append(flatEntries, passthrough...)

	// Place expanded models first, with the broadest thinking-level set at index 0.
	// Antigravity CLI initializes `session/new` on the first model and populates the
	// initial `thought_level` configOption from that model's offered levels.
	sort.Slice(expandedGroups, func(i, j int) bool {
		if len(expandedGroups[i].levels) != len(expandedGroups[j].levels) {
			return len(expandedGroups[i].levels) > len(expandedGroups[j].levels)
		}
		return compareGroupPriority(expandedGroups[i], expandedGroups[j])
	})

	result := make([]map[string]any, 0, len(normalized)*3)
	for _, group := range expandedGroups {
		result = append(result, group.entries...)
	}
	result = append(result, flatEntries...)
	return result
}

// FindModel looks up one model by action name (with or without the "models/"
// prefix) in the Antigravity CLI formatted catalog.
func FindModel(infos []*registry.ModelInfo, action string) map[string]any {
	action = strings.TrimPrefix(strings.TrimSpace(action), "/")
	if action == "" {
		return nil
	}
	normalizedAction := strings.TrimPrefix(action, "models/")
	for _, model := range BuildModels(infos) {
		if matchesModelAction(model, action, normalizedAction) {
			return model
		}
	}
	// Fall back to uncapped expansion so explicit GETs for valid unbudgeted levels
	// still succeed.
	for _, model := range buildModelsWithCap(infos, 0) {
		if matchesModelAction(model, action, normalizedAction) {
			return model
		}
	}
	return nil
}

func matchesModelAction(model map[string]any, action, normalizedAction string) bool {
	name, _ := model["name"].(string)
	return name == action || name == "models/"+action || strings.TrimPrefix(name, "models/") == normalizedAction
}

func prepareGroup(group *modelGroup) {
	if group == nil || len(group.members) == 0 {
		return
	}

	// Detect distinct non-alias dedicated effort-suffixed models in this group (e.g.,
	// `claude-opus-5-5-low`, `claude-opus-5-5-medium`, `claude-opus-5-5-high`).
	dedicatedByLevel := make(map[string]modelMember)
	for _, m := range group.members {
		if m.suffixLevel == "" || strings.TrimSpace(m.info.MetadataModelID) != "" {
			continue
		}
		existing, exists := dedicatedByLevel[m.suffixLevel]
		if !exists || preferMember(m, existing) {
			dedicatedByLevel[m.suffixLevel] = m
		}
	}

	primary := selectPrimaryMember(group.members)

	// Collect all supported effort levels offered by this group.
	primaryLevelSet := make(map[string]struct{}, len(primary.levels))
	levelSet := make(map[string]struct{}, len(supportedLevels))
	for _, lvl := range primary.levels {
		primaryLevelSet[lvl] = struct{}{}
		levelSet[lvl] = struct{}{}
	}
	if len(dedicatedByLevel) >= 2 {
		for lvl := range dedicatedByLevel {
			levelSet[lvl] = struct{}{}
		}
		// If another member in the same group declares a superset of levels (for
		// example an alias with explicit thinking config), include them when using
		// dedicated variants.
		for _, m := range group.members {
			for _, lvl := range m.levels {
				levelSet[lvl] = struct{}{}
			}
		}
	} else if len(primary.levels) > 0 {
		// If the group pairs an unsuffixed model (e.g., low..high) with a single
		// non-alias effort-suffixed variant (e.g., -xhigh) whose level is missing
		// from primary, expose that level too and route it to the dedicated variant.
		for lvl, dedicated := range dedicatedByLevel {
			if dedicated.id != primary.id {
				if _, covered := primaryLevelSet[lvl]; !covered {
					levelSet[lvl] = struct{}{}
				}
			}
		}
	}

	levels := make([]string, 0, len(levelSet))
	for _, lvl := range supportedLevels {
		if _, ok := levelSet[lvl]; ok {
			levels = append(levels, lvl)
		}
	}

	explicitLevels := len(dedicatedByLevel) >= 2 || (primary.info.Thinking != nil && len(primary.info.Thinking.Levels) > 0)

	group.primary = primary
	group.dedicatedByLevel = dedicatedByLevel
	group.primaryLevelSet = primaryLevelSet
	group.availableLevels = levels
	group.explicitLevels = explicitLevels
	group.flatEntries = buildFlatGroupEntries(group.members, primary)
}

func allocateSlotBudgets(groups []*modelGroup, passthroughCount int, maxEntries int) {
	if maxEntries <= 0 {
		for _, g := range groups {
			if len(g.availableLevels) >= 2 {
				g.allocatedSlots = len(g.availableLevels)
			} else {
				g.allocatedSlots = len(g.flatEntries)
			}
		}
		return
	}

	totalDesired := passthroughCount
	used := passthroughCount
	expandable := make([]*modelGroup, 0, len(groups))
	for _, g := range groups {
		if len(g.availableLevels) >= 2 {
			totalDesired += len(g.availableLevels)
			g.allocatedSlots = 1
			used++
			expandable = append(expandable, g)
		} else {
			g.allocatedSlots = len(g.flatEntries)
			totalDesired += g.allocatedSlots
			used += g.allocatedSlots
		}
	}

	// Everything fits comfortably without trimming.
	if totalDesired <= maxEntries {
		for _, g := range expandable {
			g.allocatedSlots = len(g.availableLevels)
		}
		return
	}

	remaining := maxEntries - used
	if remaining <= 0 {
		return
	}

	// Partition expandable groups into flagship models (non-lite/non-tiered
	// models with explicit thinking levels) and secondary models (legacy
	// budget-only models and lite/tiered variants). Under tight 32-slot budgets,
	// give all flagship models their full thinking levels before spending extra
	// slots on secondary models.
	flagships := make([]*modelGroup, 0, len(expandable))
	secondary := make([]*modelGroup, 0, len(expandable))
	for _, g := range expandable {
		if isFlagshipGroup(g) {
			flagships = append(flagships, g)
		} else {
			secondary = append(secondary, g)
		}
	}
	sort.Slice(flagships, func(i, j int) bool {
		return compareGroupPriority(flagships[i], flagships[j])
	})
	sort.Slice(secondary, func(i, j int) bool {
		return compareGroupPriority(secondary[i], secondary[j])
	})

	// Pass 1: give every flagship model at least 2 slots so each gets an Effort
	// selector in `agy` before any flagship takes a 3rd/4th/5th slot.
	for _, g := range flagships {
		if remaining <= 0 {
			return
		}
		g.allocatedSlots = 2
		remaining--
	}

	// Pass 2: fill each flagship model in priority order up to its full level set.
	for _, g := range flagships {
		for remaining > 0 && g.allocatedSlots < len(g.availableLevels) {
			g.allocatedSlots++
			remaining--
		}
	}

	// Pass 3: if any slots remain, give secondary models an Effort selector
	// (2 slots each) and water-fill the rest.
	for _, g := range secondary {
		if remaining <= 0 {
			return
		}
		g.allocatedSlots = 2
		remaining--
	}
	for remaining > 0 {
		progressed := false
		for _, g := range secondary {
			if remaining <= 0 {
				break
			}
			if g.allocatedSlots < len(g.availableLevels) {
				g.allocatedSlots++
				remaining--
				progressed = true
			}
		}
		if !progressed {
			break
		}
	}
}

func isFlagshipGroup(g *modelGroup) bool {
	if g == nil || !g.explicitLevels {
		return false
	}
	return !strings.Contains(g.key, "lite") && !strings.Contains(g.key, "tiered")
}

func compareGroupPriority(a, b *modelGroup) bool {
	if tierA, tierB := groupPriorityTier(a), groupPriorityTier(b); tierA != tierB {
		return tierA < tierB
	}
	if a.key == "gemini-4-neon" || b.key == "gemini-4-neon" {
		if a.key != b.key {
			return a.key == "gemini-4-neon"
		}
	}
	if len(a.availableLevels) != len(b.availableLevels) {
		return len(a.availableLevels) > len(b.availableLevels)
	}
	return a.key < b.key
}

func groupPriorityTier(g *modelGroup) int {
	key := g.key
	isSecondaryVariant := strings.Contains(key, "lite") || strings.Contains(key, "tiered")
	hasXHigh := false
	for _, lvl := range g.availableLevels {
		if lvl == "xhigh" {
			hasXHigh = true
			break
		}
	}
	switch {
	case !isSecondaryVariant && g.explicitLevels && hasXHigh:
		return 0
	case key == "gemini-4-carbon":
		return 1
	case !isSecondaryVariant && g.explicitLevels && strings.HasPrefix(key, "claude-"):
		return 2
	case !isSecondaryVariant && g.explicitLevels && key != "gemini-3-flash":
		return 3
	case key == "gemini-3-flash":
		return 4
	case !isSecondaryVariant:
		return 5
	default:
		return 6
	}
}

func materializeGroupEntries(group *modelGroup) {
	if group == nil || len(group.members) == 0 {
		return
	}

	// Antigravity CLI requires at least two effort levels to expose `thought_level`.
	if len(group.availableLevels) < 2 || group.allocatedSlots < 2 {
		group.expanded = false
		group.levels = nil
		group.entries = group.flatEntries
		return
	}

	levels := selectLevelsForBudget(group.availableLevels, group.allocatedSlots)
	baseDisplay := cleanDisplayName(group.primary.info.DisplayName, group.primary.baseID)
	if baseDisplay == "" {
		baseDisplay = group.primary.baseID
	}

	entries := make([]map[string]any, 0, len(levels))
	useDedicated := len(group.dedicatedByLevel) >= 2
	for _, lvl := range levels {
		displayName := baseDisplay + " (" + lvl + ")"
		if dedicated, ok := group.dedicatedByLevel[lvl]; ok {
			_, primaryCovers := group.primaryLevelSet[lvl]
			if useDedicated || (dedicated.id != group.primary.id && !primaryCovers) {
				entries = append(entries, buildGeminiModelMap(dedicated.info, dedicated.id, displayName, true))
				continue
			}
		}
		entries = append(entries, buildGeminiModelMap(group.primary.info, group.primary.id+"("+lvl+")", displayName, true))
	}

	group.expanded = true
	group.levels = levels
	group.entries = entries
}

// selectLevelsForBudget picks k levels from available (already in canonical
// order), always retaining the lowest and highest levels and preferring high,
// medium, then xhigh for interior picks.
func selectLevelsForBudget(available []string, k int) []string {
	if k >= len(available) {
		return append([]string(nil), available...)
	}
	if k <= 0 {
		return nil
	}
	if k == 1 {
		return []string{available[len(available)-1]}
	}

	chosen := make(map[string]struct{}, k)
	chosen[available[0]] = struct{}{}
	chosen[available[len(available)-1]] = struct{}{}

	interiorSet := make(map[string]struct{}, len(available)-2)
	for _, lvl := range available[1 : len(available)-1] {
		interiorSet[lvl] = struct{}{}
	}
	for _, preferred := range []string{"high", "medium", "xhigh"} {
		if len(chosen) >= k {
			break
		}
		if _, ok := interiorSet[preferred]; ok {
			chosen[preferred] = struct{}{}
		}
	}
	for _, lvl := range available {
		if len(chosen) >= k {
			break
		}
		chosen[lvl] = struct{}{}
	}

	out := make([]string, 0, k)
	for _, lvl := range available {
		if _, ok := chosen[lvl]; ok {
			out = append(out, lvl)
		}
	}
	return out
}

func buildFlatGroupEntries(members []modelMember, primary modelMember) []map[string]any {
	if len(members) <= 1 {
		return []map[string]any{
			buildGeminiModelMap(primary.info, primary.id, defaultDisplayName(primary.info, primary.id), primary.info.Thinking != nil),
		}
	}
	// Preserve distinct real catalog models when neither supports thinking expansion,
	// while still dropping forked aliases and empty-display adopted stubs.
	entries := make([]map[string]any, 0, len(members))
	for _, m := range members {
		if strings.TrimSpace(m.info.MetadataModelID) != "" {
			continue
		}
		if !m.hasDisplay && primary.hasDisplay {
			continue
		}
		entries = append(entries, buildGeminiModelMap(m.info, m.id, defaultDisplayName(m.info, m.id), m.info.Thinking != nil))
	}
	if len(entries) == 0 {
		return []map[string]any{
			buildGeminiModelMap(primary.info, primary.id, defaultDisplayName(primary.info, primary.id), primary.info.Thinking != nil),
		}
	}
	return entries
}

func selectPrimaryMember(members []modelMember) modelMember {
	best := members[0]
	for _, candidate := range members[1:] {
		if preferMember(candidate, best) {
			best = candidate
		}
	}
	return best
}

// preferMember picks the canonical member within a deduplicated model group.
// Real catalog definitions with display names beat empty adopted stubs, models
// with richer thinking metadata beat models without, and non-alias canonical
// models beat forked aliases targeting them.
func preferMember(candidate, current modelMember) bool {
	if candidate.hasDisplay != current.hasDisplay {
		return candidate.hasDisplay
	}
	if len(candidate.levels) != len(current.levels) {
		return len(candidate.levels) > len(current.levels)
	}
	candAlias := strings.TrimSpace(candidate.info.MetadataModelID) != ""
	currAlias := strings.TrimSpace(current.info.MetadataModelID) != ""
	if candAlias != currAlias {
		return !candAlias
	}
	candUnsuffixed := candidate.suffixLevel == ""
	currUnsuffixed := current.suffixLevel == ""
	if candUnsuffixed != currUnsuffixed {
		return candUnsuffixed
	}
	return candidate.id < current.id
}

func buildGeminiModelMap(info *registry.ModelInfo, modelID, displayName string, thinkingEnabled bool) map[string]any {
	name := modelID
	if !strings.HasPrefix(name, "models/") {
		name = "models/" + name
	}
	if strings.TrimSpace(displayName) == "" {
		displayName = modelID
	}
	description := strings.TrimSpace(info.Description)
	if description == "" {
		description = displayName
	}

	// Emit only standard Gemini Model fields. Antigravity CLI validates the
	// `/v1beta/models` JSON schema and uses the boolean `thinking` field to enable
	// `includeThoughts` for non-Gemini models such as Claude.
	result := map[string]any{
		"name":        name,
		"displayName": displayName,
		"description": description,
	}
	if thinkingEnabled {
		result["thinking"] = true
	}
	if info.Version != "" {
		result["version"] = info.Version
	}
	inputTokenLimit := info.InputTokenLimit
	if inputTokenLimit <= 0 {
		inputTokenLimit = info.ContextLength
	}
	if inputTokenLimit > 0 {
		result["inputTokenLimit"] = inputTokenLimit
	}
	outputTokenLimit := info.OutputTokenLimit
	if outputTokenLimit <= 0 {
		outputTokenLimit = info.MaxCompletionTokens
	}
	// Antigravity CLI rejects models whose outputTokenLimit >= inputTokenLimit
	// when constructing its planner executor (contextWindow - maxOutputTokens <= 0).
	if outputTokenLimit > 0 && (inputTokenLimit <= 0 || outputTokenLimit < inputTokenLimit) {
		result["outputTokenLimit"] = outputTokenLimit
	}
	if len(info.SupportedGenerationMethods) > 0 {
		result["supportedGenerationMethods"] = append([]string(nil), info.SupportedGenerationMethods...)
	} else {
		result["supportedGenerationMethods"] = []string{"generateContent"}
	}
	if len(info.SupportedInputModalities) > 0 {
		result["supportedInputModalities"] = append([]string(nil), info.SupportedInputModalities...)
	}
	if len(info.SupportedOutputModalities) > 0 {
		result["supportedOutputModalities"] = append([]string(nil), info.SupportedOutputModalities...)
	}
	return result
}

func normalizeModelID(info *registry.ModelInfo) string {
	if info == nil {
		return ""
	}
	if id := normalizeRawID(info.ID); id != "" {
		return id
	}
	return normalizeRawID(info.Name)
}

func normalizeRawID(raw string) string {
	return strings.TrimPrefix(strings.TrimSpace(raw), "models/")
}

func defaultDisplayName(info *registry.ModelInfo, fallbackID string) string {
	if info != nil && strings.TrimSpace(info.DisplayName) != "" {
		return strings.TrimSpace(info.DisplayName)
	}
	return fallbackID
}

// splitEffortSuffix splits a trailing "-low", "-medium", "-high", "-xhigh" or
// "-max" effort marker from the last path segment of a model ID.
func splitEffortSuffix(id string) (base string, level string) {
	prefix := ""
	segment := id
	if slash := strings.LastIndexByte(id, '/'); slash >= 0 {
		prefix = id[:slash+1]
		segment = id[slash+1:]
	}
	lower := strings.ToLower(segment)
	for _, candidate := range supportedLevels {
		suffix := "-" + candidate
		if strings.HasSuffix(lower, suffix) && len(segment) > len(suffix) {
			return prefix + segment[:len(segment)-len(suffix)], candidate
		}
	}
	return id, ""
}

func stripTrailingThinkingSegment(id string) string {
	lower := strings.ToLower(id)
	const suffix = "-thinking"
	if strings.HasSuffix(lower, suffix) && len(id) > len(suffix) {
		return id[:len(id)-len(suffix)]
	}
	return id
}

// cleanDisplayName removes trailing thinking/effort parentheticals (such as
// "(High)" or "(Thinking)") and unwraps remaining parenthetical qualifiers
// (such as "(Tiered)") so appending " (<level>)" produces clean model names
// and slugified ACP model IDs in Antigravity CLI.
func cleanDisplayName(raw, fallbackID string) string {
	name := strings.TrimSpace(raw)
	if name == "" {
		name = strings.TrimSpace(fallbackID)
	}
	for {
		open := strings.LastIndexByte(name, '(')
		if open <= 0 || !strings.HasSuffix(name, ")") {
			break
		}
		inner := strings.TrimSpace(name[open+1 : len(name)-1])
		prefix := strings.TrimSpace(name[:open])
		if prefix == "" {
			break
		}
		if isThinkingQualifier(inner) {
			name = prefix
			continue
		}
		if inner != "" {
			name = prefix + " " + inner
			continue
		}
		name = prefix
	}
	return strings.TrimSpace(name)
}

func isThinkingQualifier(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "thinking", "none", "auto", "minimal", "low", "medium", "high", "xhigh", "extra", "extra high", "max":
		return true
	default:
		return false
	}
}

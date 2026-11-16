package quotahistory

import (
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/MoeForge/moego/ojson"
)

// Window ids shared with the management panel.
const (
	WindowFiveHour      = "five_hour"
	WindowSevenDay      = "seven_day"
	WindowSevenDayFable = "seven_day_fable"
	WindowSevenDayOpus  = "seven_day_opus"
)

const (
	fiveHourSeconds = 5 * 60 * 60
	weekSeconds     = 7 * 24 * 60 * 60
)

// Window is one quota window observation.
type Window struct {
	UsedPercent float64 `json:"used_percent"`
	ResetsAt    *int64  `json:"resets_at"`
	PeriodHours float64 `json:"period_hours"`
	// Label is the provider's own name for the window, when it has one.
	Label      string  `json:"label,omitempty"`
	Budget     float64 `json:"budget,omitempty"`
	Currency   string  `json:"currency,omitempty"`
	modelScope []string
	// estimated marks a used percent the payload did not state.
	estimated bool
}

var errEmptyPayload = errors.New("empty or invalid usage payload")

// ParseClaudeUsage maps the Claude OAuth usage payload
// (GET https://api.anthropic.com/api/oauth/usage) to window ids. It mirrors the
// panel parser in web/src/features/quota/providers/claude/data.ts: the Fable
// weekly cap comes from limits[] (kind weekly_scoped, model "Fable"/"Fable 5"),
// falling back to the legacy iguana_necktie window when it is not a dollar pool.
func ParseClaudeUsage(body []byte) (map[string]Window, error) {
	root := ojson.ParseBytes(body)
	if !root.IsObject() {
		return nil, errEmptyPayload
	}
	windows := make(map[string]Window)
	for _, key := range []string{WindowFiveHour, WindowSevenDay, WindowSevenDayOpus} {
		if w, ok := claudeWindow(root.Get(key), key); ok {
			windows[key] = w
		}
	}
	if w, ok := claudeFableLimit(root.Get("limits")); ok {
		windows[WindowSevenDayFable] = w
	} else if legacy := root.Get("iguana_necktie"); legacy.IsObject() && !isDollarWindow(legacy) {
		if w, okLegacy := claudeWindow(legacy, WindowSevenDay); okLegacy {
			windows[WindowSevenDayFable] = w
		}
	}
	return windows, nil
}

func claudeWindow(raw ojson.Result, key string) (Window, bool) {
	if !raw.IsObject() {
		return Window{}, false
	}
	used, ok := number(raw.Get("utilization"))
	if !ok {
		return Window{}, false
	}
	period := 168.0
	if key == WindowFiveHour {
		period = 5
	}
	return Window{UsedPercent: used, ResetsAt: resetMs(raw.Get("resets_at")), PeriodHours: period}, true
}

func claudeFableLimit(limits ojson.Result) (Window, bool) {
	if !limits.IsArray() {
		return Window{}, false
	}
	var picked *ojson.Result
	for _, item := range limits.Array() {
		kind := strings.ToLower(strings.TrimSpace(item.Get("kind").String()))
		model := strings.ToLower(strings.TrimSpace(item.Get("scope.model.display_name").String()))
		if kind != "weekly_scoped" || (model != "fable" && model != "fable 5") {
			continue
		}
		if _, ok := number(item.Get("percent")); !ok {
			continue
		}
		candidate := item
		if item.Get("is_active").Type == ojson.True {
			picked = &candidate
			break
		}
		if picked == nil {
			picked = &candidate
		}
	}
	if picked == nil {
		return Window{}, false
	}
	used, _ := number(picked.Get("percent"))
	return Window{UsedPercent: used, ResetsAt: resetMs(picked.Get("resets_at")), PeriodHours: 168}, true
}

func isDollarWindow(raw ojson.Result) bool {
	for _, key := range []string{"limit_dollars", "used_dollars", "remaining_dollars"} {
		if _, ok := number(raw.Get(key)); ok {
			return true
		}
	}
	return false
}

// ParseClaudePlan maps the Claude OAuth profile payload
// (GET https://api.anthropic.com/api/oauth/profile) to a plan id such as
// "max_20x", "max_5x", "max", "pro", "team" or "free". It returns "" when unknown.
func ParseClaudePlan(body []byte) string {
	root := ojson.ParseBytes(body)
	if !root.IsObject() {
		return ""
	}
	org := root.Get("organization")
	orgType := strings.ToLower(strings.TrimSpace(org.Get("organization_type").String()))
	subStatus := strings.ToLower(strings.TrimSpace(org.Get("subscription_status").String()))
	if orgType == "claude_team" && subStatus == "active" {
		return "team"
	}
	tier := org.Get("rate_limit_tier").String()
	if tier == "" {
		tier = org.Get("rateLimitTier").String()
	}
	tier = strings.ToLower(strings.TrimSpace(tier))
	switch {
	case strings.HasSuffix(tier, "claude_max_20x"):
		return "max_20x"
	case strings.HasSuffix(tier, "claude_max_5x"):
		return "max_5x"
	}
	hasMax, maxKnown := flag(root.Get("account.has_claude_max"))
	if maxKnown && hasMax {
		return "max"
	}
	hasPro, proKnown := flag(root.Get("account.has_claude_pro"))
	if proKnown && hasPro {
		return "pro"
	}
	if maxKnown && proKnown {
		return "free"
	}
	return ""
}

// ParseCodexUsage maps the Codex usage payload
// (GET https://chatgpt.com/backend-api/wham/usage) to window ids by window
// length: 300 minutes is five_hour, 10080 minutes is seven_day. Payloads
// without a window length fall back to primary/secondary order, like the panel.
// It also returns the lower-cased plan_type.
func ParseCodexUsage(body []byte, now time.Time) (map[string]Window, string, error) {
	root := ojson.ParseBytes(body)
	if !root.IsObject() {
		return nil, "", errEmptyPayload
	}
	plan := firstString(root.Get("plan_type"), root.Get("planType"))
	plan = strings.ToLower(plan)

	windows := make(map[string]Window)
	rateLimit := firstExisting(root.Get("rate_limit"), root.Get("rateLimit"))
	if !rateLimit.IsObject() {
		return windows, plan, nil
	}
	limitReached := rateLimit.Get("limit_reached").Type == ojson.True ||
		rateLimit.Get("limitReached").Type == ojson.True ||
		rateLimit.Get("allowed").Type == ojson.False
	primary := firstExisting(rateLimit.Get("primary_window"), rateLimit.Get("primaryWindow"))
	secondary := firstExisting(rateLimit.Get("secondary_window"), rateLimit.Get("secondaryWindow"))

	for i, raw := range []ojson.Result{primary, secondary} {
		if !raw.IsObject() {
			continue
		}
		seconds, hasSeconds := number(firstExisting(raw.Get("limit_window_seconds"), raw.Get("limitWindowSeconds")))
		var id string
		switch {
		case hasSeconds && seconds == fiveHourSeconds:
			id = WindowFiveHour
		case hasSeconds && seconds == weekSeconds:
			id = WindowSevenDay
		case !hasSeconds && i == 0:
			id = WindowFiveHour
			seconds = fiveHourSeconds
		case !hasSeconds && i == 1:
			id = WindowSevenDay
			seconds = weekSeconds
		default:
			continue
		}
		if _, exists := windows[id]; exists {
			continue
		}
		used, ok := number(firstExisting(raw.Get("used_percent"), raw.Get("usedPercent")))
		if !ok {
			if !limitReached {
				continue
			}
			// The payload says a limit was hit but not which window.
			used = 100
		}
		estimated := !ok
		reset := resetMs(firstExisting(raw.Get("reset_at"), raw.Get("resetAt")))
		if reset == nil {
			if after, okAfter := number(firstExisting(raw.Get("reset_after_seconds"), raw.Get("resetAfterSeconds"))); okAfter && after > 0 {
				ms := now.Add(time.Duration(after * float64(time.Second))).UnixMilli()
				reset = &ms
			}
		}
		windows[id] = Window{UsedPercent: used, ResetsAt: reset, PeriodHours: seconds / 3600, estimated: estimated}
	}
	return windows, plan, nil
}

// number reads a finite JSON number or numeric string.
func number(r ojson.Result) (float64, bool) {
	switch r.Type {
	case ojson.Number:
		v := r.Float()
		return v, !math.IsNaN(v) && !math.IsInf(v, 0)
	case ojson.String:
		v, errParse := strconv.ParseFloat(strings.TrimSpace(r.String()), 64)
		if errParse != nil || math.IsNaN(v) || math.IsInf(v, 0) {
			return 0, false
		}
		return v, true
	default:
		return 0, false
	}
}

// resetMs parses an ISO-8601 string or a unix timestamp (seconds or ms) to unix ms.
func resetMs(r ojson.Result) *int64 {
	var ms int64
	switch r.Type {
	case ojson.String:
		raw := strings.TrimSpace(r.String())
		if raw == "" {
			return nil
		}
		if t, errParse := time.Parse(time.RFC3339Nano, raw); errParse == nil {
			ms = t.UnixMilli()
			break
		}
		v, errParse := strconv.ParseFloat(raw, 64)
		if errParse != nil {
			return nil
		}
		ms = unixToMs(v)
	case ojson.Number:
		ms = unixToMs(r.Float())
	default:
		return nil
	}
	if ms <= 0 {
		return nil
	}
	return &ms
}

func unixToMs(v float64) int64 {
	if v <= 0 {
		return 0
	}
	if v < 1e11 {
		return int64(v * 1000)
	}
	return int64(v)
}

func flag(r ojson.Result) (value, known bool) {
	switch r.Type {
	case ojson.True:
		return true, true
	case ojson.False:
		return false, true
	case ojson.Number:
		return r.Float() != 0, true
	case ojson.String:
		switch strings.ToLower(strings.TrimSpace(r.String())) {
		case "true", "1", "yes", "y", "on":
			return true, true
		case "false", "0", "no", "n", "off":
			return false, true
		}
	}
	return false, false
}

func firstExisting(values ...ojson.Result) ojson.Result {
	for _, v := range values {
		if v.Exists() && v.Type != ojson.Null {
			return v
		}
	}
	return ojson.Result{}
}

func firstString(values ...ojson.Result) string {
	for _, v := range values {
		if v.Type == ojson.String {
			if s := strings.TrimSpace(v.String()); s != "" {
				return s
			}
		}
	}
	return ""
}

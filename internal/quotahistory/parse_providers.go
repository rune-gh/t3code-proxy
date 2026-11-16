package quotahistory

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/MoeForge/moego/ojson"
)

func usageRoot(body []byte) (ojson.Result, error) {
	if !ojson.ValidBytes(body) {
		return ojson.Result{}, errEmptyPayload
	}
	root := ojson.ParseBytes(body)
	if !root.IsObject() {
		return root, errEmptyPayload
	}
	return root, nil
}

func clampedPercent(value float64) float64 { return math.Max(0, math.Min(100, value)) }

func parseMistralUsage(body []byte, now time.Time) (map[string]Window, error) {
	root, err := usageRoot(body)
	if err != nil {
		return nil, err
	}
	now = now.UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
	period := start.AddDate(0, 1, 0).Sub(start).Hours()
	windows := make(map[string]Window)
	for _, budget := range []struct{ key, id, label string }{
		{"api_budget", "api_monthly", "API usage"},
		{"vibe_budget", "vibe_monthly", "Vibe Code"},
	} {
		raw := root.Get(budget.key)
		used, ok := number(raw.Get("usage_percentage"))
		if !raw.IsObject() || !ok || used < 0 {
			continue
		}
		window := Window{UsedPercent: used, ResetsAt: resetMs(raw.Get("reset_at")), PeriodHours: period, Label: budget.label}
		if amount, hasAmount := number(raw.Get("initial_budget")); hasAmount && amount >= 0 {
			window.Budget = amount
		}
		window.Currency = firstString(raw.Get("currency"))
		windows[budget.id] = window
	}
	if len(windows) == 0 {
		return nil, errEmptyPayload
	}
	return windows, nil
}

func parseMistralPlan(body []byte) string {
	root, err := usageRoot(body)
	if err != nil {
		return ""
	}
	return firstString(root.Get("plan_name"))
}

func parseMetaUsage(body []byte) (map[string]Window, error) {
	root, err := usageRoot(body)
	if err != nil {
		return nil, err
	}
	windows := make(map[string]Window)
	for _, key := range []string{"window", "weekly"} {
		raw := root.Get("subs_usage." + key)
		used, ok := number(raw.Get("used_percent"))
		if !ok {
			continue
		}
		period := 168.0
		if key == "window" {
			minutes, _ := number(raw.Get("window_duration_mins"))
			period = math.Max(0, minutes/60)
		}
		windows[key] = Window{UsedPercent: clampedPercent(used), ResetsAt: resetMs(raw.Get("resets_at")), PeriodHours: period}
	}
	return windows, nil
}

func parseDevinUsage(body []byte) (map[string]Window, error) {
	root, err := usageRoot(body)
	if err != nil {
		return nil, err
	}
	status := root.Get("userStatus.planStatus")
	windows := make(map[string]Window)
	for _, key := range []string{"daily", "weekly"} {
		remaining, ok := number(status.Get(key + "QuotaRemainingPercent"))
		if !ok || remaining < 0 || remaining > 100 {
			continue
		}
		period := 24.0
		if key == "weekly" {
			period = 168
		}
		windows[key] = Window{UsedPercent: 100 - remaining, ResetsAt: resetMs(status.Get(key + "QuotaResetAtUnix")), PeriodHours: period}
	}
	if len(windows) == 0 {
		return nil, errEmptyPayload
	}
	return windows, nil
}

func parseXAIUsage(body []byte) (map[string]Window, error) {
	root, err := usageRoot(body)
	if err != nil {
		return nil, err
	}
	config := root.Get("config")
	if !config.IsObject() {
		return nil, errEmptyPayload
	}
	windows := make(map[string]Window)
	current := firstExisting(config.Get("currentPeriod"), config.Get("current_period"))
	if used, ok := number(firstExisting(config.Get("creditUsagePercent"), config.Get("credit_usage_percent"))); ok {
		key := "weekly"
		if strings.Contains(strings.ToLower(current.Get("type").String()), "monthly") {
			key = "monthly"
		}
		start := firstExisting(current.Get("start"), config.Get("billingPeriodStart"), config.Get("billing_period_start"))
		end := firstExisting(current.Get("end"), config.Get("billingPeriodEnd"), config.Get("billing_period_end"))
		windows[key] = datedWindow(used, start, end)
	}
	limit := firstExisting(config.Get("monthlyLimit"), config.Get("monthly_limit"))
	if limit.IsObject() {
		limit = limit.Get("val")
	}
	spent := config.Get("used")
	if spent.IsObject() {
		spent = spent.Get("val")
	}
	cap, hasCap := number(limit)
	used, hasUsed := number(spent)
	if hasCap && cap > 0 && hasUsed && used >= 0 {
		windows["monthly"] = datedWindow(used/cap*100, firstExisting(config.Get("billingPeriodStart"), config.Get("billing_period_start")), firstExisting(config.Get("billingPeriodEnd"), config.Get("billing_period_end")))
	}
	return windows, nil
}

// Billing periods must have both boundaries to establish a renewing duration.
func datedWindow(used float64, start, end ojson.Result) Window {
	reset, begin := resetMs(end), resetMs(start)
	period := 0.0
	if reset != nil && begin != nil && *reset > *begin {
		period = float64(*reset-*begin) / float64(time.Hour/time.Millisecond)
	}
	return Window{UsedPercent: clampedPercent(used), ResetsAt: reset, PeriodHours: period}
}

func parseKimiUsage(body []byte, now time.Time) (map[string]Window, error) {
	root, err := usageRoot(body)
	if err != nil {
		return nil, err
	}
	windows := make(map[string]Window)
	for index, item := range root.Get("limits").Array() {
		detail := item.Get("detail")
		if !detail.IsObject() {
			detail = item
		}
		label := firstString(detail.Get("name"), detail.Get("title"), item.Get("name"), item.Get("title"), item.Get("scope"), detail.Get("scope"))
		duration, _ := number(firstExisting(item.Get("window.duration"), item.Get("duration"), detail.Get("duration")))
		unit := firstString(item.Get("window.timeUnit"), item.Get("timeUnit"), detail.Get("timeUnit"))
		period := kimiPeriod(label, duration, unit)
		key := stableKey(label)
		if key == "" && period > 0 {
			key = fmt.Sprintf("%gh", period)
		}
		key = "limit_" + indexedKey(key, index)
		// Repeated labels retain separate windows instead of overwriting a cap.
		if _, exists := windows[key]; exists {
			key = fmt.Sprintf("%s_%d", key, index)
		}
		if window, ok := kimiWindow(detail, period, now); ok {
			window.Label = strings.TrimSpace(label)
			windows[key] = window
		}
	}
	if window, ok := kimiWindow(root.Get("usage"), 168, now); ok {
		windows["summary"] = window
	}
	monthly := root.Get("usages.limit_month_total")
	if ratio, ok := number(monthly.Get("used_ratio")); ok && ratio >= 0 {
		windows["monthly"] = Window{UsedPercent: clampedPercent(ratio * 100), ResetsAt: resetMs(monthly.Get("reset_time")), PeriodHours: 720}
	}
	return windows, nil
}

func kimiPeriod(label string, duration float64, unit string) float64 {
	if duration > 0 {
		switch strings.TrimSuffix(strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(unit)), "TIME_UNIT_"), "S") {
		case "SECOND":
			return duration / 3600
		case "HOUR":
			return duration
		case "DAY":
			return duration * 24
		case "WEEK":
			return duration * 168
		default:
			return duration / 60
		}
	}
	label = strings.ToLower(label)
	switch {
	case strings.Contains(label, "daily"), strings.Contains(label, "day"):
		return 24
	case strings.Contains(label, "weekly"), strings.Contains(label, "week"):
		return 168
	case strings.Contains(label, "monthly"), strings.Contains(label, "month"):
		return 720
	case strings.Contains(label, "5h"), strings.Contains(label, "hour"):
		return 5
	default:
		return 0
	}
}

func kimiWindow(raw ojson.Result, period float64, now time.Time) (Window, bool) {
	cap, hasCap := number(raw.Get("limit"))
	used, hasUsed := number(raw.Get("used"))
	if !hasUsed {
		if remaining, ok := number(raw.Get("remaining")); ok && hasCap {
			used, hasUsed = cap-remaining, true
		}
	}
	if !hasCap || cap <= 0 || !hasUsed {
		return Window{}, false
	}
	reset := resetMs(firstExisting(raw.Get("reset_at"), raw.Get("resetAt"), raw.Get("reset_time"), raw.Get("resetTime")))
	if reset == nil {
		for _, field := range []string{"reset_in", "resetIn", "ttl"} {
			if seconds, ok := number(raw.Get(field)); ok && seconds > 0 {
				ms := now.Add(time.Duration(seconds * float64(time.Second))).UnixMilli()
				reset = &ms
				break
			}
		}
	}
	return Window{UsedPercent: clampedPercent(used / cap * 100), ResetsAt: reset, PeriodHours: period}, true
}

func parseQuotaGroups(body []byte, modelScoped bool) (map[string]Window, error) {
	root, err := usageRoot(body)
	if err != nil {
		return nil, err
	}
	windows := make(map[string]Window)
	for groupIndex, group := range root.Get("groups").Array() {
		name := firstString(group.Get("displayName"), group.Get("display_name"))
		groupID := indexedKey(name, groupIndex)
		for bucketIndex, bucket := range group.Get("buckets").Array() {
			remaining, ok := number(firstExisting(bucket.Get("remainingFraction"), bucket.Get("remaining_fraction")))
			if !ok {
				continue
			}
			// The panel also accepts percentages in remainingFraction.
			if remaining > 1 && remaining <= 100 {
				remaining /= 100
			}
			remaining = math.Max(0, math.Min(1, remaining))
			window := firstString(bucket.Get("window"))
			period := 0.0
			switch strings.ToLower(strings.TrimSpace(window)) {
			case "5h", "five-hour", "five_hour":
				period = 5
			case "weekly", "week":
				period = 168
			case "daily", "day":
				period = 24
			default:
				if duration, ok := parseDuration(window); ok {
					period = duration.Hours()
				}
			}
			bucketID := firstString(bucket.Get("bucketId"), bucket.Get("bucket_id"))
			key := "group_" + groupID + "_" + indexedKey(bucketID, bucketIndex)
			if bucketID == "" && window != "" {
				key = "group_" + groupID + "_" + stableKey(window)
			}
			if _, exists := windows[key]; exists {
				key = fmt.Sprintf("%s_%d", key, bucketIndex)
			}
			scope := quotaGroupScope(bucketID, name)
			if modelScoped && len(scope) == 0 {
				// Unidentified model pools remain visible in history but cannot govern routing.
				scope = []string{""}
			}
			label := strings.TrimSpace(strings.TrimSpace(name) + " " + strings.ToLower(strings.TrimSpace(window)))
			windows[key] = Window{UsedPercent: clampedPercent((1 - remaining) * 100), ResetsAt: resetMs(firstExisting(bucket.Get("resetTime"), bucket.Get("reset_time"))), PeriodHours: period, Label: label, modelScope: scope}
		}
	}
	return windows, nil
}

func quotaGroupScope(bucketID, groupName string) []string {
	// Bucket IDs identify the pool. Strip the renewing-window suffix before
	// matching a family pool or a model-specific pool against model IDs.
	id := strings.ToLower(strings.TrimSpace(bucketID))
	for _, suffix := range []string{"-weekly", "-week", "-five-hour", "-five_hour", "-5h"} {
		id = strings.TrimSuffix(id, suffix)
	}
	for _, family := range []string{"gemini", "claude", "gpt"} {
		if id == family {
			return []string{family + "-*"}
		}
		if strings.HasPrefix(id, family+"-") {
			return []string{id, id + "-*"}
		}
		if bucketID == "" && strings.HasPrefix(strings.ToLower(strings.TrimSpace(groupName)), family) {
			return []string{family + "-*"}
		}
	}
	return nil
}

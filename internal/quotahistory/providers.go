package quotahistory

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/MoeForge/moego/ojson"
	kimiauth "github.com/rune-oai/t3code-proxy/internal/auth/kimi"
	"github.com/rune-oai/t3code-proxy/internal/misc"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

const (
	XAIWeeklyURL  = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
	XAIMonthlyURL = "https://cli-chat-proxy.grok.com/v1/billing"
	// XAISettingsURL and XAIUserURL name the subscription behind a Grok login.
	XAISettingsURL = "https://cli-chat-proxy.grok.com/v1/settings"
	XAIUserURL     = "https://cli-chat-proxy.grok.com/v1/user?include=subscription"
	// AntigravityCodeAssistURL reports the subscription tier of a Google account.
	AntigravityCodeAssistURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
	MetaUsageURL             = "https://api.meta.ai/muse-code/key"
	DevinUsageURL            = "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"
	MistralBudgetURL         = "https://api.mistral.ai/v1/billing/budget"
	MistralSubscriptionURL   = "https://api.mistral.ai/v1/billing/subscription"
	// MistralWhoamiURL names the customer behind a Mistral key, so two keys of
	// one customer (an API key and a Vibe key) are recorded as one account.
	MistralWhoamiURL = "https://console.mistral.ai/api/vibe/whoami"
)

var antigravityQuotaURLs = []string{
	"https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
	"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
}

type providerPoller func(*Recorder, context.Context, *coreauth.Auth) (map[string]Window, string, error)

var providerPollers = map[string]providerPoller{
	"claude": func(r *Recorder, ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
		windows, err := r.fetchClaude(ctx, auth)
		plan := ""
		if err == nil {
			plan = r.claudePlan(ctx, auth)
		}
		return windows, plan, err
	},
	"codex": func(r *Recorder, ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
		windows, plan, err := r.fetchCodex(ctx, auth)
		if plan == "" {
			plan = metadataString(auth, "plan_type")
		}
		return windows, plan, err
	},
	"xai": func(r *Recorder, ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
		windows, plan, err := r.fetchXAI(ctx, auth)
		if err == nil && plan == "" {
			plan = r.cachedPlan(auth, func() string { return r.xaiPlan(ctx, auth) })
		}
		return windows, plan, err
	},
	"antigravity": func(r *Recorder, ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
		windows, plan, err := r.fetchAntigravity(ctx, auth)
		if err == nil && plan == "" {
			plan = r.cachedPlan(auth, func() string { return r.antigravityPlan(ctx, auth) })
		}
		return windows, plan, err
	},
	"kimi":    (*Recorder).fetchKimi,
	"kimi-ai": (*Recorder).fetchKimi,
	"meta":    (*Recorder).fetchMeta,
	"devin":   (*Recorder).fetchDevin,
	"mistral": (*Recorder).fetchMistral,
}

func (r *Recorder) fetchMistral(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	body, err := r.get(ctx, auth, MistralBudgetURL, bearerHeaders())
	if err != nil {
		return nil, "", err
	}
	windows, errParse := parseMistralUsage(body, r.now())
	if errParse != nil {
		return nil, "", errParse
	}
	plan := r.cachedPlan(auth, func() string {
		body, errGet := r.get(ctx, auth, MistralSubscriptionURL, bearerHeaders())
		if errGet != nil {
			return ""
		}
		return parseMistralPlan(body)
	})
	r.refreshMistralCustomer(ctx, auth)
	return windows, plan, nil
}

// refreshMistralCustomer learns the customer behind a Mistral key at most once
// per profileTTL. A failed request keeps what was known.
func (r *Recorder) refreshMistralCustomer(ctx context.Context, auth *coreauth.Auth) {
	r.plansMu.Lock()
	last := r.customerAttempts[auth.Index]
	due := last.IsZero() || r.now().Sub(last) >= profileTTL
	if due {
		r.customerAttempts[auth.Index] = r.now()
	}
	r.plansMu.Unlock()
	if !due {
		return
	}
	body, err := r.get(ctx, auth, MistralWhoamiURL, bearerHeaders())
	if err != nil {
		return
	}
	if id := firstString(ojson.ParseBytes(body).Get("customer_id")); id != "" {
		r.plansMu.Lock()
		r.customers[auth.Index] = id
		r.plansMu.Unlock()
	}
}

// mistralDuplicates returns the Mistral keys that another key of the same
// customer already represents. Both keys read the same monthly budgets, so
// recording both would count each allowance twice. The key without a model
// prefix represents the customer, then the lowest index.
func (r *Recorder) mistralDuplicates(auths []*coreauth.Auth) map[string]bool {
	r.plansMu.Lock()
	customers := make(map[string]string, len(r.customers))
	for index, id := range r.customers {
		customers[index] = id
	}
	r.plansMu.Unlock()
	groups := make(map[string][]*coreauth.Auth)
	for _, auth := range auths {
		if providerOf(auth) != "mistral" {
			continue
		}
		if id := customers[auth.Index]; id != "" {
			groups[id] = append(groups[id], auth)
		}
	}
	duplicates := make(map[string]bool)
	for _, group := range groups {
		sort.Slice(group, func(i, j int) bool {
			pi, pj := strings.TrimSpace(group[i].Prefix) != "", strings.TrimSpace(group[j].Prefix) != ""
			if pi != pj {
				return !pi
			}
			return group[i].Index < group[j].Index
		})
		for _, auth := range group[1:] {
			duplicates[auth.Index] = true
		}
	}
	return duplicates
}

func bearerHeaders() map[string]string {
	return map[string]string{"Authorization": "Bearer $TOKEN$", "Content-Type": "application/json", "Accept": "application/json"}
}

func xaiHeaders(auth *coreauth.Auth) map[string]string {
	headers := bearerHeaders()
	headers["x-xai-token-auth"] = "xai-grok-cli"
	headers["x-grok-client-version"] = "1.0.70"
	headers["User-Agent"] = "grok-pager/1.0.70 grok-shell/1.0.70 (macos; aarch64)"
	for _, key := range []string{"sub", "subject", "user_id", "userId", "oauth.sub", "oauth.subject", "user.sub", "user.id"} {
		if userID := accountValue(auth, key); userID != "" {
			headers["x-userid"] = userID
			break
		}
	}
	return headers
}

// xaiPlan names the Grok subscription by its display name ("SuperGrok"), which
// is what plan weights are keyed by. The internal tier ("GrokPro") is used only
// when the settings answer carries no display name; a failed settings request
// yields no plan, so a known plan is kept and the request is retried.
func (r *Recorder) xaiPlan(ctx context.Context, auth *coreauth.Auth) string {
	headers := xaiHeaders(auth)
	settings, errSettings := r.get(ctx, auth, XAISettingsURL, headers)
	if errSettings != nil {
		return ""
	}
	root := ojson.ParseBytes(settings)
	if plan := firstString(root.Get("subscription_tier_display"), root.Get("subscriptionTierDisplay")); plan != "" {
		return plan
	}
	body, err := r.get(ctx, auth, XAIUserURL, headers)
	if err != nil {
		return ""
	}
	user := ojson.ParseBytes(body)
	return firstString(user.Get("subscriptionTier"), user.Get("subscription_tier"))
}

var antigravityTierPlans = map[string]string{
	"free-tier":          "free",
	"g1-pro-tier":        "pro",
	"g1-ultra-tier":      "ultra",
	"g1-ultra-lite-tier": "ultra-lite",
}

// antigravityPlan names the Google subscription tier. The paid tier wins over
// the current tier, as in the panel's account view.
func (r *Recorder) antigravityPlan(ctx context.Context, auth *coreauth.Auth) string {
	headers := bearerHeaders()
	headers["User-Agent"] = misc.AntigravityUserAgent()
	body, err := r.request(ctx, auth, "POST", AntigravityCodeAssistURL, headers, []byte(`{"metadata":{"ideType":"ANTIGRAVITY"}}`))
	if err != nil {
		return ""
	}
	return parseAntigravityPlan(body)
}

func parseAntigravityPlan(body []byte) string {
	root := ojson.ParseBytes(body)
	for _, tier := range []ojson.Result{
		firstExisting(root.Get("paidTier"), root.Get("paid_tier")),
		firstExisting(root.Get("currentTier"), root.Get("current_tier")),
	} {
		id := firstString(tier.Get("id"))
		if id == "" {
			continue
		}
		if plan := antigravityTierPlans[id]; plan != "" {
			return plan
		}
		if name := firstString(tier.Get("name")); name != "" {
			return name
		}
		return id
	}
	return ""
}

func (r *Recorder) fetchXAI(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	headers := xaiHeaders(auth)
	windows := make(map[string]Window)
	var lastErr error
	for _, url := range []string{XAIWeeklyURL, XAIMonthlyURL} {
		body, err := r.get(ctx, auth, url, headers)
		if err != nil {
			lastErr = err
			continue
		}
		parsed, errParse := parseXAIUsage(body)
		if errParse != nil {
			lastErr = errParse
			continue
		}
		for key, window := range parsed {
			windows[key] = window
		}
	}
	if len(windows) == 0 && lastErr != nil {
		return nil, "", lastErr
	}
	return windows, "", nil
}

func (r *Recorder) fetchKimi(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	host := "api.kimi.com"
	if kimiauth.IsKimiAIDomain(kimiauth.ResolveKimiDomainFromAuth(auth)) {
		host = "api.kimi.ai"
	}
	body, err := r.get(ctx, auth, "https://"+host+"/coding/v1/usages", bearerHeaders())
	if err != nil {
		return nil, "", err
	}
	windows, errParse := parseKimiUsage(body, r.now())
	return windows, "", errParse
}

func (r *Recorder) fetchMeta(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	// Muse quota requires the persisted DCA credential, independently of the LLM key.
	token := accountValue(auth, "dca_token")
	if !strings.HasPrefix(token, "dca:") || strings.ContainsAny(token, " \t\r\n") {
		return nil, "", errors.New("missing Meta DCA credential")
	}
	headers := bearerHeaders()
	headers["Authorization"] = "Bearer " + token
	headers["x-api-version"] = "1.0.0"
	body, err := r.request(ctx, auth, "POST", MetaUsageURL, headers, []byte("{}"))
	if err != nil {
		return nil, "", err
	}
	windows, errParse := parseMetaUsage(body)
	root := ojson.ParseBytes(body)
	return windows, firstString(root.Get("subs_tier_name"), root.Get("subs_usage.tier")), errParse
}

func (r *Recorder) fetchDevin(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	doc := ojson.NewDocString(`{"metadata":{"ideName":"chisel","ideVersion":"3000.10.21","apiKey":"$TOKEN$","locale":"en","os":"darwin","extensionVersion":"3000.10.21","clientName":"chisel"}}`)
	body, err := r.request(ctx, auth, "POST", DevinUsageURL, map[string]string{"Content-Type": "application/json", "Connect-Protocol-Version": "1"}, doc.Bytes())
	if err != nil {
		return nil, "", err
	}
	windows, errParse := parseDevinUsage(body)
	return windows, firstString(ojson.ParseBytes(body).Get("userStatus.planStatus.planInfo.planName")), errParse
}

func (r *Recorder) fetchAntigravity(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	project := ""
	for _, key := range []string{"project_id", "projectId", "gemini_virtual_project", "installed.project_id", "installed.projectId", "web.project_id", "web.projectId"} {
		if project = accountValue(auth, key); project != "" {
			break
		}
	}
	if project == "" {
		return nil, "", errors.New("missing Antigravity project ID")
	}
	doc := ojson.NewDocString(`{}`)
	if errSet := doc.Set("project", project); errSet != nil {
		return nil, "", errors.New("invalid Antigravity project ID")
	}
	headers := bearerHeaders()
	headers["User-Agent"] = misc.AntigravityUserAgent()
	windows := make(map[string]Window)
	var lastErr error
	for _, url := range antigravityQuotaURLs {
		body, err := r.request(ctx, auth, "POST", url, headers, doc.Bytes())
		if err != nil {
			lastErr = err
			continue
		}
		parsed, errParse := parseQuotaGroups(body, true)
		if errParse != nil {
			lastErr = errParse
			continue
		}
		hasGemini := false
		for key, window := range parsed {
			if _, exists := windows[key]; !exists {
				windows[key] = window
			}
			for _, scope := range window.modelScope {
				if strings.HasPrefix(scope, "gemini") {
					hasGemini = true
				}
			}
		}
		if hasGemini {
			break
		}
	}
	if len(windows) == 0 {
		if lastErr == nil {
			lastErr = errEmptyPayload
		}
		return nil, "", lastErr
	}
	return windows, "", nil
}

func (r *Recorder) fetchPlugin(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	if r.deps.FetchPlugin == nil {
		return nil, "", errors.New("no quota provider")
	}
	body, err := r.deps.FetchPlugin(ctx, auth)
	if err != nil {
		return nil, "", errors.New("plugin quota request failed")
	}
	windows, errParse := parseQuotaGroups(body, false)
	return windows, firstString(ojson.ParseBytes(body).Get("subscription.plan")), errParse
}

// accountValue reads normalized metadata first, then routing attributes and storage.
func accountValue(auth *coreauth.Auth, key string) string {
	if value := metadataString(auth, key); value != "" {
		return value
	}
	if value := strings.TrimSpace(auth.Attributes[key]); value != "" {
		return value
	}
	for _, source := range []any{auth.Metadata, auth.Storage} {
		doc := ojson.NewDocString(`{}`)
		if err := doc.Set("account", source); err == nil {
			if value := firstString(doc.Get("account." + key)); value != "" {
				return value
			}
		}
	}
	return ""
}

func stableKey(value string) string {
	fields := strings.FieldsFunc(strings.ToLower(strings.TrimSpace(value)), func(r rune) bool {
		return (r < 'a' || r > 'z') && (r < '0' || r > '9')
	})
	return strings.Join(fields, "_")
}

func indexedKey(value string, index int) string {
	if key := stableKey(value); key != "" {
		return key
	}
	return fmt.Sprintf("%d", index)
}

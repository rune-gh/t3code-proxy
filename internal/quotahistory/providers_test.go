package quotahistory

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/config"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func TestRecorderProviderRequestsAndPublication(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	for _, provider := range []string{"xai", "antigravity", "kimi", "kimi-ai", "meta", "devin", "fixture-plugin"} {
		t.Run(provider, func(t *testing.T) {
			auth := &coreauth.Auth{ID: t.Name(), Index: t.Name(), Provider: provider, Metadata: map[string]any{"project_id": "fixture-project", "dca_token": "dca:fixture", "sub": "fixture-user"}}
			if provider == "kimi-ai" {
				auth.Metadata["domain"] = "kimi.ai"
			}
			t.Cleanup(func() { coreauth.ForgetQuotaWindows(auth.ID) })
			fixture := provider
			if fixture == "kimi-ai" {
				fixture = "kimi"
			}
			if fixture == "fixture-plugin" {
				fixture = "plugin"
			}
			body := quotaFixture(t, fixture)
			var urls []string
			deps := Deps{DoRequest: func(ctx context.Context, got *coreauth.Auth, method, url string, headers map[string]string, data []byte) (int, []byte, error) {
				if got != auth {
					t.Fatal("wrong account")
				}
				// Each account's sample is bounded so a silent provider cannot stall the recorder.
				if deadline, bounded := ctx.Deadline(); !bounded || time.Until(deadline) > sampleTimeout {
					t.Fatal("usage sample is not bounded by sampleTimeout")
				}
				urls = append(urls, url)
				switch provider {
				case "xai":
					if method != "GET" || headers["x-userid"] != "fixture-user" || headers["x-xai-token-auth"] != "xai-grok-cli" {
						t.Fatalf("xai request %s %v", method, headers)
					}
				case "antigravity":
					if url == AntigravityCodeAssistURL {
						break
					}
					if method != "POST" || ojson.GetBytes(data, "project").String() != "fixture-project" {
						t.Fatalf("antigravity request %s %s", method, data)
					}
				case "meta":
					if method != "POST" || headers["Authorization"] != "Bearer dca:fixture" || string(data) != "{}" {
						t.Fatalf("meta request %s %s", method, data)
					}
				case "devin":
					if method != "POST" || ojson.GetBytes(data, "metadata.apiKey").String() != "$TOKEN$" || headers["Connect-Protocol-Version"] != "1" {
						t.Fatalf("devin request %s %s", method, data)
					}
				default:
					if method != "GET" || headers["Authorization"] != "Bearer $TOKEN$" {
						t.Fatalf("kimi request %s %v", method, headers)
					}
				}
				return 200, body, nil
			}, FetchPlugin: func(_ context.Context, got *coreauth.Auth) ([]byte, error) {
				if got != auth {
					t.Fatal("wrong plugin account")
				}
				return body, nil
			}}
			r := NewRecorder(deps)
			r.now = func() time.Time { return now }
			rec := r.sample(context.Background(), auth)
			if rec.Error != "" || len(rec.Windows) == 0 {
				t.Fatalf("sample = %+v", rec)
			}
			expectedURLs := map[string][]string{
				"xai": {XAIWeeklyURL, XAIMonthlyURL, XAISettingsURL, XAIUserURL}, "antigravity": {antigravityQuotaURLs[0], AntigravityCodeAssistURL}, "kimi": {"https://api.kimi.com/coding/v1/usages"}, "kimi-ai": {"https://api.kimi.ai/coding/v1/usages"}, "meta": {MetaUsageURL}, "devin": {DevinUsageURL},
			}
			if !reflect.DeepEqual(urls, expectedURLs[provider]) {
				t.Fatalf("urls = %v, want %v", urls, expectedURLs[provider])
			}
			observed, windows := coreauth.ObservedQuotaWindows(auth.ID)
			if !observed.Equal(now) || len(windows) == 0 {
				t.Fatalf("observation = %v %+v", observed, windows)
			}
		})
	}
}

func TestRecorderProvidersAllowlistReloadAndDisabled(t *testing.T) {
	auths := []*coreauth.Auth{
		{ID: "quota-kimi", Index: "quota-kimi", Provider: "kimi"},
		{ID: "quota-meta", Index: "quota-meta", Provider: "meta", Disabled: true},
		{ID: "quota-xai", Index: "quota-xai", Provider: "xai", Status: coreauth.StatusDisabled},
		{ID: "quota-plugin", Index: "quota-plugin", Provider: "fixture-plugin"},
		{ID: "quota-unknown", Index: "quota-unknown", Provider: "unknown"},
	}
	r := NewRecorder(Deps{ListAuths: func() []*coreauth.Auth { return auths }, PluginProviders: func(context.Context) map[string]string { return map[string]string{"fixture-plugin": "fixture"} }})
	r.startupDelay = time.Hour
	t.Cleanup(r.Close)
	s := enabledSettings(t)
	if err := r.Apply(s); err != nil {
		t.Fatal(err)
	}
	// Plugins are only asked during a poll; before one, history lists built-in providers.
	if got := len(r.accounts()); got != 3 {
		t.Fatalf("accounts before the first poll = %d, want 3", got)
	}
	if targets := r.targets(context.Background()); len(targets) != 2 {
		t.Fatalf("targets = %v", targets)
	}
	if got := len(r.accounts()); got != 4 {
		t.Fatalf("accounts = %d, want 4", got)
	}
	cfg := &config.Config{QuotaHistory: config.QuotaHistoryConfig{Providers: []string{" KIMI ", "meta"}}}
	resolved, err := SettingsFromConfig(cfg, "config.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Providers != "kimi,meta" {
		t.Fatalf("providers = %q", resolved.Providers)
	}
	s.Providers = resolved.Providers
	if err := r.Apply(s); err != nil {
		t.Fatal(err)
	}
	if got := len(r.accounts()); got != 2 {
		t.Fatalf("restricted accounts = %d, want 2", got)
	}
	if targets := r.targets(context.Background()); len(targets) != 1 || targets[0].Provider != "kimi" {
		t.Fatalf("restricted targets = %v", targets)
	}
}

func TestAntigravityFallbackKeepsPartialPools(t *testing.T) {
	auth := &coreauth.Auth{ID: t.Name(), Provider: "antigravity", Metadata: map[string]any{"project_id": "fixture"}}
	calls := 0
	r := NewRecorder(Deps{DoRequest: func(_ context.Context, _ *coreauth.Auth, _, url string, _ map[string]string, _ []byte) (int, []byte, error) {
		if url != antigravityQuotaURLs[calls] {
			t.Fatalf("unexpected URL %s", url)
		}
		calls++
		switch calls {
		case 1:
			return 200, []byte(`{"groups":[{"displayName":"Claude Models","buckets":[{"bucketId":"claude-weekly","window":"weekly","remainingFraction":0.5}]}]}`), nil
		case 2:
			return 503, nil, nil
		default:
			return 200, quotaFixture(t, "antigravity"), nil
		}
	}})
	windows, _, err := r.fetchAntigravity(context.Background(), auth)
	if err != nil || calls != 3 || len(windows) != 4 || windows["group_claude_models_claude_weekly"].UsedPercent != 50 {
		t.Fatalf("fallback = %+v %v, calls %d", windows, err, calls)
	}
}

func TestQuotaErrorsExcludeResponseSecrets(t *testing.T) {
	r := NewRecorder(Deps{DoRequest: func(context.Context, *coreauth.Auth, string, string, map[string]string, []byte) (int, []byte, error) {
		return 401, []byte(`{"error":{"message":"secret-token"},"api_key":"secret-key"}`), nil
	}})
	auth := &coreauth.Auth{ID: t.Name(), Provider: "meta", Metadata: map[string]any{"dca_token": "dca:fixture"}}
	rec := r.sample(context.Background(), auth)
	if rec.Error != "HTTP 401" {
		t.Fatalf("unsafe error %q", rec.Error)
	}
	r.deps.FetchPlugin = func(context.Context, *coreauth.Auth) ([]byte, error) { return nil, errors.New("secret-token") }
	auth.Provider = "fixture-plugin"
	rec = r.sample(context.Background(), auth)
	if strings.Contains(rec.Error, "secret") {
		t.Fatalf("unsafe plugin error %q", rec.Error)
	}
}

func TestRecorderNamesGrokAndAntigravityPlans(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	planCalls := map[string]int{}
	planBodies := map[string]string{
		XAISettingsURL:           `{"subscription_tier_display":"SuperGrok"}`,
		AntigravityCodeAssistURL: `{"currentTier":{"id":"free-tier","name":"Free"},"paidTier":{"id":"g1-pro-tier","name":"Google AI Pro"}}`,
	}
	r := NewRecorder(Deps{DoRequest: func(_ context.Context, auth *coreauth.Auth, _, url string, _ map[string]string, _ []byte) (int, []byte, error) {
		if body, ok := planBodies[url]; ok {
			planCalls[url]++
			return 200, []byte(body), nil
		}
		return 200, quotaFixture(t, auth.Provider), nil
	}})
	r.now = func() time.Time { return now }
	xai := &coreauth.Auth{ID: t.Name() + "-xai", Index: t.Name() + "-xai", Provider: "xai", Metadata: map[string]any{"access_token": "fixture"}}
	antigravity := &coreauth.Auth{ID: t.Name() + "-ag", Index: t.Name() + "-ag", Provider: "antigravity", Metadata: map[string]any{"project_id": "fixture-project"}}
	for auth, want := range map[*coreauth.Auth]string{xai: "SuperGrok", antigravity: "pro"} {
		if rec := r.sample(context.Background(), auth); rec.Error != "" || rec.Plan != want {
			t.Fatalf("%s sample plan = %q (error %q), want %q", auth.Provider, rec.Plan, rec.Error, want)
		}
		if got := coreauth.PlanOf(auth); got != config.NormalizePlanKey(want) {
			t.Fatalf("%s routing plan = %q, want %q", auth.Provider, got, config.NormalizePlanKey(want))
		}
	}

	// The plan endpoints are asked once per profileTTL, not on every poll.
	now = now.Add(profileTTL - time.Minute)
	for _, auth := range []*coreauth.Auth{xai, antigravity} {
		if rec := r.sample(context.Background(), auth); rec.Plan == "" {
			t.Fatalf("%s lost its cached plan", auth.Provider)
		}
	}
	if planCalls[XAISettingsURL] != 1 || planCalls[AntigravityCodeAssistURL] != 1 {
		t.Fatalf("plan requests = %v, want one each", planCalls)
	}

	// A failing plan endpoint keeps the known plan.
	now = now.Add(2 * time.Minute)
	planBodies[XAISettingsURL] = `{}`
	if rec := r.sample(context.Background(), xai); rec.Plan != "SuperGrok" {
		t.Fatalf("plan after an empty refresh = %q, want SuperGrok", rec.Plan)
	}
}

func TestRecorderRetriesAnUnknownPlanOnTheNextPoll(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	settingsStatus, settingsCalls, userCalls := 503, 0, 0
	r := NewRecorder(Deps{DoRequest: func(_ context.Context, auth *coreauth.Auth, _, url string, _ map[string]string, _ []byte) (int, []byte, error) {
		switch url {
		case XAISettingsURL:
			settingsCalls++
			return settingsStatus, []byte(`{"subscription_tier_display":"SuperGrok Heavy"}`), nil
		case XAIUserURL:
			userCalls++
			return 200, []byte(`{"subscriptionTier":"GrokPro"}`), nil
		}
		return 200, quotaFixture(t, auth.Provider), nil
	}})
	r.now = func() time.Time { return now }
	xai := &coreauth.Auth{ID: t.Name(), Index: t.Name(), Provider: "xai", Metadata: map[string]any{"access_token": "fixture"}}

	// A failed settings request leaves the plan unknown instead of storing the internal
	// tier, which no plan weight is keyed by.
	if rec := r.sample(context.Background(), xai); rec.Error != "" || rec.Plan != "" {
		t.Fatalf("sample with settings down = plan %q, error %q; want no plan", rec.Plan, rec.Error)
	}
	if userCalls != 0 {
		t.Fatalf("user endpoint asked %d times after a failed settings request, want 0", userCalls)
	}

	// The next poll asks again instead of waiting out profileTTL.
	now = now.Add(15 * time.Minute)
	settingsStatus = 200
	if rec := r.sample(context.Background(), xai); rec.Plan != "SuperGrok Heavy" {
		t.Fatalf("plan on the next poll = %q, want SuperGrok Heavy", rec.Plan)
	}
	if settingsCalls != 2 {
		t.Fatalf("settings asked %d times, want 2", settingsCalls)
	}
	if got := coreauth.PlanWeightOf(xai); got != 10 {
		t.Fatalf("routing weight = %v, want 10", got)
	}
}

func TestParseAntigravityPlan(t *testing.T) {
	for body, want := range map[string]string{
		`{"currentTier":{"id":"free-tier"}}`:                                     "free",
		`{"paid_tier":{"id":"g1-ultra-tier"},"current_tier":{"id":"free-tier"}}`: "ultra",
		`{"currentTier":{"id":"new-tier","name":"Google AI Next"}}`:              "Google AI Next",
		`{"currentTier":{"id":"new-tier"}}`:                                      "new-tier",
		`{}`:                                                                     "",
	} {
		if got := parseAntigravityPlan([]byte(body)); got != want {
			t.Fatalf("parseAntigravityPlan(%s) = %q, want %q", body, got, want)
		}
	}
}

package quotahistory

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/watcher/synthesizer"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

const mistralBudgetFixture = `{"vibe_budget":{"usage_percentage":0.0,"initial_budget":150.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z","payg_enabled":false},"api_budget":{"usage_percentage":2.59892596,"initial_budget":15.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z","payg_enabled":false},"usage_percentage":2.59892596,"initial_budget":15.0,"currency":"USD","reset_at":"2026-12-01T00:00:00Z"}`
const mistralSubscriptionFixture = `{"plan_name":"EDU","payg_enabled":false,"vibe_payg_enabled":false,"enterprise":false}`

func TestParseMistralUsage(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	reset := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	windows, err := parseMistralUsage([]byte(mistralBudgetFixture), now)
	want := map[string]Window{
		"api_monthly":  {UsedPercent: 2.59892596, ResetsAt: &reset, PeriodHours: 720, Label: "API usage", Budget: 15, Currency: "USD"},
		"vibe_monthly": {UsedPercent: 0, ResetsAt: &reset, PeriodHours: 720, Label: "Vibe Code", Budget: 150, Currency: "USD"},
	}
	if err != nil || !reflect.DeepEqual(windows, want) {
		t.Fatalf("usage = %+v, %v, want %+v", windows, err, want)
	}
	if plan := parseMistralPlan([]byte(mistralSubscriptionFixture)); plan != "EDU" {
		t.Fatalf("plan = %q", plan)
	}
	for _, body := range []string{`{}`, `null`, `[]`, `not json`, `{"api_budget":`, `{"usage_percentage":5}`, `{"api_budget":{"usage_percentage":"NaN"}}`, `{"api_budget":{"usage_percentage":-1}}`} {
		if _, errParse := parseMistralUsage([]byte(body), now); !errors.Is(errParse, errEmptyPayload) {
			t.Errorf("invalid payload %s: %v", body, errParse)
		}
	}
	for _, body := range []string{`{}`, `null`, `{"plan_name":42}`, `{"plan_name":"EDU"`} {
		if plan := parseMistralPlan([]byte(body)); plan != "" {
			t.Errorf("invalid plan payload %s: %q", body, plan)
		}
	}
	for _, key := range []string{"api_budget", "vibe_budget"} {
		t.Run(key, func(t *testing.T) {
			doc := ojson.NewDocString(mistralBudgetFixture)
			other, id := "vibe_budget", "api_monthly"
			if key == "vibe_budget" {
				other, id = "api_budget", "vibe_monthly"
			}
			_ = doc.Delete(other)
			_ = doc.Delete(key + ".reset_at")
			_ = doc.Set(key+".usage_percentage", 125.5)
			windows, errParse := parseMistralUsage(doc.Bytes(), now)
			if errParse != nil || len(windows) != 1 || windows[id].UsedPercent != 125.5 || windows[id].ResetsAt != nil {
				t.Fatalf("single budget without reset = %+v, %v", windows, errParse)
			}
		})
	}
}

func TestMistralCalendarMonthHours(t *testing.T) {
	for _, tc := range []struct {
		now   time.Time
		hours float64
	}{
		{time.Date(2026, 1, 31, 23, 0, 0, 0, time.UTC), 744},
		{time.Date(2026, 2, 15, 0, 0, 0, 0, time.UTC), 672},
		{time.Date(2028, 2, 15, 0, 0, 0, 0, time.UTC), 696},
		{time.Date(2026, 12, 15, 0, 0, 0, 0, time.UTC), 744},
		// The local date is February while the UTC date is still January.
		{time.Date(2026, 2, 1, 1, 0, 0, 0, time.FixedZone("UTC+2", 2*3600)), 744},
	} {
		windows, err := parseMistralUsage([]byte(`{"api_budget":{"usage_percentage":1}}`), tc.now)
		if err != nil || windows["api_monthly"].PeriodHours != tc.hours {
			t.Errorf("%s: windows = %+v, %v, want %g hours", tc.now, windows, err, tc.hours)
		}
	}
}

func TestMistralBillingErrorIsBounded(t *testing.T) {
	r := NewRecorder(Deps{Do: func(context.Context, *coreauth.Auth, string, string, map[string]string) (int, []byte, error) {
		return 401, []byte(`{"error":"fixture-secret-key"}`), nil
	}})
	if _, _, err := r.fetchMistral(context.Background(), &coreauth.Auth{}); err == nil || err.Error() != "HTTP 401" {
		t.Fatalf("billing error = %v", err)
	}
}

func TestRecorderMistralAPIKeyAccounts(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	cfg := &config.Config{OpenAICompatibility: []config.OpenAICompatibility{
		{Name: "Campus account", BaseURL: "https://api.mistral.ai/v1", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "fixture-mistral-key"}}},
		{Name: "mistral", BaseURL: "https://other.example/v1", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "fixture-other-key"}}},
	}}
	manager := coreauth.NewManager(nil, nil, nil)
	manager.SetConfig(&config.Config{Routing: config.RoutingConfig{PlanWeights: map[string]map[string]float64{"mistral": {"edu": 8}}}})
	t.Cleanup(func() { manager.SetConfig(nil) })
	synthesize := func() []*coreauth.Auth {
		t.Helper()
		auths, err := synthesizer.NewConfigSynthesizer().Synthesize(&synthesizer.SynthesisContext{Config: cfg, Now: now, IDGenerator: synthesizer.NewStableIDGenerator()})
		if err != nil || len(auths) != 2 {
			t.Fatalf("synthesis = %d accounts, %v", len(auths), err)
		}
		return auths
	}
	auths := synthesize()
	index := auths[0].EnsureIndex()
	if index == "" || index != synthesize()[0].EnsureIndex() || strings.Contains(index, "fixture") {
		t.Fatalf("API-key index is not stable and opaque: %q", index)
	}
	calls := map[string]int{}
	planStatus := 200
	r := NewRecorder(Deps{
		ListAuths: func() []*coreauth.Auth { return auths },
		Label:     func(*coreauth.Auth) string { return "fixture-mistral-key" },
		DoRequest: func(_ context.Context, auth *coreauth.Auth, method, url string, header map[string]string, data []byte) (int, []byte, error) {
			if auth.ID != auths[0].ID || method != "GET" || header["Authorization"] != "Bearer $TOKEN$" || auth.Attributes["api_key"] != "fixture-mistral-key" || len(data) != 0 {
				t.Error("wrong account or Bearer request")
				return 400, nil, nil
			}
			calls[url]++
			switch url {
			case MistralBudgetURL:
				return 200, []byte(mistralBudgetFixture), nil
			case MistralSubscriptionURL:
				return planStatus, []byte(mistralSubscriptionFixture), nil
			case MistralWhoamiURL:
				return 200, []byte(`{"customer_id":"fixture-customer"}`), nil
			}
			t.Errorf("unexpected billing URL %q", url)
			return 404, nil, nil
		},
	})
	var clock atomic.Int64
	clock.Store(now.UnixNano())
	r.now = func() time.Time { return time.Unix(0, clock.Load()) }
	r.startupDelay = time.Hour
	s := enabledSettings(t)
	if err := r.Apply(s); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.Close)
	for _, providers := range []string{"", "mistral"} {
		r.providers.Store(providers)
		now = now.Add(time.Minute)
		clock.Store(now.UnixNano())
		if n := r.poll(context.Background(), r.store, 0, nil); n != 1 {
			t.Fatalf("allowlist %q: %d samples", providers, n)
		}
	}
	if calls[MistralBudgetURL] != 2 || calls[MistralSubscriptionURL] != 1 {
		t.Fatalf("billing calls = %v", calls)
	}
	history, err := r.History(0, 0)
	if err != nil || len(history.Accounts) != 1 || len(history.Samples) != 2 {
		t.Fatalf("history = %+v, %v", history, err)
	}
	account := history.Accounts[0]
	if account.AuthIndex != index || account.Provider != "mistral" || account.Label != "Campus account" || account.Plan != "EDU" || account.Weight != 1 {
		t.Fatalf("account = %+v", account)
	}
	// Reopening seeds the display plan without publishing a routing plan.
	r.Close()
	if err := r.Apply(s); err != nil {
		t.Fatal(err)
	}
	if accounts := r.accounts(); len(accounts) != 1 || accounts[0].Plan != "EDU" || coreauth.PlanOf(auths[0]) != "" {
		t.Fatalf("reopened accounts = %+v", accounts)
	}
	now = now.Add(profileTTL)
	clock.Store(now.UnixNano())
	planStatus = 503
	if rec := r.sample(context.Background(), auths[0]); rec.Error != "" || rec.Plan != "EDU" || calls[MistralSubscriptionURL] != 2 {
		t.Fatalf("failed plan refresh = %+v, calls %v", rec, calls)
	}
	r.providers.Store("codex")
	if n := r.poll(context.Background(), r.store, 0, nil); n != 0 || len(r.accounts()) != 0 {
		t.Fatal("an allowlist excluding Mistral must skip its accounts")
	}
	r.providers.Store("mistral")
	auths[0].Disabled = true
	if n := r.poll(context.Background(), r.store, 0, nil); n != 0 || !r.accounts()[0].Disabled {
		t.Fatal("a disabled Mistral account must remain listed without polling")
	}
}

func TestMistralHostDetection(t *testing.T) {
	for _, tc := range []struct {
		base string
		want bool
	}{
		{"https://api.mistral.ai/v1", true},
		{"https://API.MISTRAL.AI:443/v1/", true},
		{"https://api.mistral.ai.example/v1", false},
		{"https://api.mistral.ai@other.example/v1", false},
		{"https://other.example/api.mistral.ai", false},
		{":invalid", false},
	} {
		auth := &coreauth.Auth{ID: "host-test", Provider: "mistral", Attributes: map[string]string{"api_key": "fixture", "base_url": tc.base}}
		r := NewRecorder(Deps{ListAuths: func() []*coreauth.Auth { return []*coreauth.Auth{auth} }})
		if got := len(r.trackable(nil)) == 1; got != tc.want {
			t.Errorf("%s: trackable = %t", tc.base, got)
		}
		delete(auth.Attributes, "api_key")
		if len(r.trackable(nil)) != 0 {
			t.Errorf("%s: tracked without an API key", tc.base)
		}
	}
}

func TestMistralSpentBudgetsDoNotGovernRouting(t *testing.T) {
	spent := &coreauth.Auth{ID: t.Name() + "-spent", Provider: "openai-compatible-campus", Attributes: map[string]string{"compat_name": "Campus", "api_key": "fixture-spent", "base_url": "https://api.mistral.ai/v1"}}
	fresh := spent.Clone()
	fresh.ID = t.Name() + "-fresh"
	fresh.Attributes["api_key"] = "fixture-fresh"
	auths := []*coreauth.Auth{spent, fresh}
	r := NewRecorder(Deps{ListAuths: func() []*coreauth.Auth { return auths }, Do: func(_ context.Context, auth *coreauth.Auth, _, url string, _ map[string]string) (int, []byte, error) {
		if url == MistralSubscriptionURL {
			return 200, []byte(mistralSubscriptionFixture), nil
		}
		used := 0
		if auth.ID == spent.ID {
			used = 125
		}
		doc := ojson.NewDocString(mistralBudgetFixture)
		_ = doc.Set("api_budget.usage_percentage", used)
		_ = doc.Set("vibe_budget.usage_percentage", 100)
		return 200, doc.Bytes(), nil
	}})
	for _, auth := range r.trackable(nil) {
		rec := r.sample(context.Background(), auth)
		if rec.Error != "" || len(rec.Windows) != 2 {
			t.Fatalf("sample = %+v", rec)
		}
		if observed, windows := coreauth.ObservedQuotaWindows(auth.ID); !observed.IsZero() || len(windows) != 0 || coreauth.PlanOf(auth) != "" {
			t.Fatalf("usage-only account published routing observations: %v %+v", observed, windows)
		}
	}
	selector := &coreauth.SoonestResetFirstSelector{}
	seen := map[string]bool{}
	for range 4 {
		picked, err := selector.Pick(context.Background(), spent.Provider, "mistral-vibe-cli-latest", executor.Options{}, auths)
		if err != nil || picked == nil {
			t.Fatalf("pick = %v, %v", picked, err)
		}
		seen[picked.ID] = true
	}
	if !seen[spent.ID] || !seen[fresh.ID] {
		t.Fatalf("spent budget excluded an account from rotation: %v", seen)
	}
}

func TestStoreMistralBudgetsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "qh.db")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	windows, err := parseMistralUsage([]byte(mistralBudgetFixture), time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	rec := record{Sample: Sample{T: 5, AuthIndex: "mistral-index", Windows: windows}, Plan: "EDU"}
	if errPut := store.put(rec); errPut != nil {
		t.Fatal(errPut)
	}
	if errClose := store.Close(); errClose != nil {
		t.Fatal(errClose)
	}
	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if errClose := reopened.Close(); errClose != nil {
			t.Error(errClose)
		}
	})
	if records := collect(t, reopened, 0, 10); len(records) != 1 || !reflect.DeepEqual(records[0], rec) {
		t.Fatalf("budget round trip = %+v", records)
	}
	doc := ojson.NewDocString(`{}`)
	if errSet := doc.Set("window", Window{UsedPercent: 20, PeriodHours: 5}); errSet != nil {
		t.Fatal(errSet)
	}
	if got := doc.Get("window").Raw; got != `{"used_percent":20,"resets_at":null,"period_hours":5}` {
		t.Fatalf("legacy window JSON changed: %s", got)
	}
}

// Two keys of one Mistral customer read the same budgets: an API key and the key
// Mistral Vibe signs in with. They are recorded as one account, the one without
// a model prefix, so neither allowance is counted twice.
func TestRecorderMergesMistralKeysOfOneCustomer(t *testing.T) {
	now := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	cfg := &config.Config{OpenAICompatibility: []config.OpenAICompatibility{
		{Name: "mistral-vibe", Prefix: "vibe", BaseURL: "https://api.mistral.ai/v1", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "fixture-vibe-key"}}},
		{Name: "mistral", BaseURL: "https://api.mistral.ai/v1", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "fixture-api-key"}}},
		{Name: "mistral-other", BaseURL: "https://api.mistral.ai/v1", APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "fixture-other-key"}}},
	}}
	auths, err := synthesizer.NewConfigSynthesizer().Synthesize(&synthesizer.SynthesisContext{Config: cfg, Now: now, IDGenerator: synthesizer.NewStableIDGenerator()})
	if err != nil || len(auths) != 3 {
		t.Fatalf("synthesis = %d accounts, %v", len(auths), err)
	}
	customerOf := map[string]string{"fixture-vibe-key": "customer-a", "fixture-api-key": "customer-a", "fixture-other-key": "customer-b"}
	whoamiStatus := 200
	var afterWhoami func(*coreauth.Auth)
	deps := Deps{
		ListAuths: func() []*coreauth.Auth { return auths },
		DoRequest: func(_ context.Context, auth *coreauth.Auth, _, url string, _ map[string]string, _ []byte) (int, []byte, error) {
			switch url {
			case MistralBudgetURL:
				return 200, []byte(mistralBudgetFixture), nil
			case MistralSubscriptionURL:
				return 200, []byte(mistralSubscriptionFixture), nil
			case MistralWhoamiURL:
				if afterWhoami != nil {
					afterWhoami(auth)
				}
				return whoamiStatus, []byte(`{"customer_id":"` + customerOf[auth.Attributes["api_key"]] + `"}`), nil
			}
			return 404, nil, nil
		},
	}
	var clock atomic.Int64
	clock.Store(now.UnixMilli())
	open := func(settings Settings) *Recorder {
		t.Helper()
		recorder := NewRecorder(deps)
		recorder.now = func() time.Time { return time.UnixMilli(clock.Load()) }
		recorder.startupDelay = time.Hour
		if err := recorder.Apply(settings); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(recorder.Close)
		return recorder
	}
	historyOf := func(recorder *Recorder) History {
		t.Helper()
		history, err := recorder.History(0, 0)
		if err != nil {
			t.Fatal(err)
		}
		return history
	}
	settings := enabledSettings(t)
	r := open(settings)
	// The first round learns the customers as it goes, so a key polled before its
	// sibling may still be stored once; history hides it.
	if n := r.poll(context.Background(), r.store, 0, nil); n < 2 || n > 3 {
		t.Fatalf("first round stored %d samples, want 2 or 3", n)
	}
	clock.Add(time.Minute.Milliseconds())
	if n := r.poll(context.Background(), r.store, 0, nil); n != 2 {
		t.Fatalf("stored %d samples, want 2 (one per customer)", n)
	}
	history := historyOf(r)
	labels := map[string]bool{}
	for _, account := range history.Accounts {
		labels[account.Label] = true
	}
	if len(history.Accounts) != 2 || !labels["mistral"] || !labels["mistral-other"] || labels["mistral-vibe"] {
		t.Fatalf("accounts = %+v, want mistral and mistral-other", history.Accounts)
	}
	listed := map[string]bool{}
	for _, account := range history.Accounts {
		listed[account.AuthIndex] = true
	}
	for _, sample := range history.Samples {
		if !listed[sample.AuthIndex] {
			t.Fatalf("history serves a sample of an unlisted account: %+v", sample)
		}
	}
	if len(history.Samples) != 4 {
		t.Fatalf("samples = %d, want 4 (two rounds, two customers)", len(history.Samples))
	}

	// A customer that cannot be read keeps the last one known.
	whoamiStatus = 503
	r.Close()
	restarted := open(settings)
	if reopened := historyOf(restarted); !reflect.DeepEqual(reopened, history) {
		t.Fatalf("history before the first poll after restart changed: %d accounts and %d samples", len(reopened.Accounts), len(reopened.Samples))
	}
	clock.Add(profileTTL.Milliseconds())
	if n := restarted.poll(context.Background(), restarted.store, 0, nil); n != 2 {
		t.Fatalf("stored %d samples after a failed customer read, want 2", n)
	}

	// A new database must retain a verified identity even for a disabled
	// duplicate key that no longer gets polled.
	auths[0].Disabled = true // mistral-vibe
	settings.Path = filepath.Join(t.TempDir(), "new.db")
	if err := restarted.Apply(settings); err != nil {
		t.Fatal(err)
	}
	if n := restarted.poll(context.Background(), restarted.store, 0, nil); n != 2 {
		t.Fatalf("stored %d samples after switching databases, want 2", n)
	}
	history = historyOf(restarted)
	restarted.Close()
	if reopened := historyOf(open(settings)); !reflect.DeepEqual(reopened, history) {
		t.Fatalf("history before the first poll after switching databases and restarting changed: %d accounts and %d samples", len(reopened.Accounts), len(reopened.Samples))
	}

	// Shutdown can arrive just after the second key's lookup succeeds. Save
	// the verified grouping while discarding the cancelled usage sample.
	auths[0].Disabled = false
	whoamiStatus = 200
	settings.Path = filepath.Join(t.TempDir(), "cancel.db")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelIndex := max(auths[0].EnsureIndex(), auths[1].EnsureIndex())
	afterWhoami = func(auth *coreauth.Auth) {
		if auth.Index == cancelIndex {
			cancel()
		}
	}
	cancelled := open(settings)
	cancelled.poll(ctx, cancelled.store, 0, nil)
	if ctx.Err() == nil {
		t.Fatal("the second same-customer lookup did not cancel the poll")
	}
	cancelled.Close()
	history = historyOf(open(settings))
	if len(history.Accounts) != 2 {
		t.Fatalf("accounts after cancelling and restarting = %+v, want two customers", history.Accounts)
	}
	for _, sample := range history.Samples {
		if sample.AuthIndex == cancelIndex {
			t.Fatal("stored the cancelled usage sample")
		}
	}
}

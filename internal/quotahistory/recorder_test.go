package quotahistory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

type fakeUpstream struct {
	mu       sync.Mutex
	requests []string
	headers  []map[string]string
}

func (f *fakeUpstream) do(_ context.Context, auth *coreauth.Auth, method, url string, header map[string]string) (int, []byte, error) {
	f.mu.Lock()
	f.requests = append(f.requests, auth.Index+" "+method+" "+url)
	f.headers = append(f.headers, header)
	f.mu.Unlock()
	switch {
	case auth.Index == "claude-broken":
		return 401, []byte(`{"error":{"message":"token expired"}}`), nil
	case url == ClaudeUsageURL:
		return 200, []byte(claudeUsageFixture), nil
	case url == ClaudeProfileURL:
		return 200, []byte(`{"organization":{"rate_limit_tier":"default_claude_max_20x"}}`), nil
	case url == CodexUsageURL:
		return 200, []byte(`{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":10,"limit_window_seconds":18000,"reset_at":1731610000},"secondary_window":{"used_percent":50,"limit_window_seconds":604800,"reset_at":1731900000}}}`), nil
	}
	return 0, nil, errors.New("unexpected url")
}

func testAuths() []*coreauth.Auth {
	return []*coreauth.Auth{
		{ID: "c1", Index: "claude-ok", Provider: "claude", Metadata: map[string]any{"email": "a@example.com", "access_token": "secret-a"}},
		{ID: "c2", Index: "claude-broken", Provider: "Claude", Metadata: map[string]any{"email": "b@example.com", "access_token": "secret-b"}},
		{ID: "x1", Index: "codex-ok", Provider: "codex", Label: "codex label", Metadata: map[string]any{"access_token": "secret-c", "account_id": "acct-1"}},
		{ID: "x2", Index: "codex-off", Provider: "codex", Disabled: true, Metadata: map[string]any{"email": "off@example.com", "access_token": "secret-d"}},
		{ID: "k1", Index: "claude-key", Provider: "claude", Attributes: map[string]string{"api_key": "sk-ant"}},
		{ID: "g1", Index: "gemini", Provider: "gemini", Metadata: map[string]any{"access_token": "g"}},
	}
}

func newTestRecorder(t *testing.T, up *fakeUpstream) *Recorder {
	t.Helper()
	r := NewRecorder(Deps{ListAuths: testAuths, Do: up.do})
	r.manualGap = 0
	r.scheduledGap = 0
	r.startupDelay = time.Hour
	t.Cleanup(r.Close)
	return r
}

func enabledSettings(t *testing.T) Settings {
	return Settings{Enabled: true, Interval: DefaultInterval, Retention: DefaultRetention, Path: filepath.Join(t.TempDir(), "qh.db")}
}

func TestRecorderDisabled(t *testing.T) {
	up := &fakeUpstream{}
	r := newTestRecorder(t, up)
	if errApply := r.Apply(Settings{Interval: DefaultInterval, Retention: DefaultRetention}); errApply != nil {
		t.Fatal(errApply)
	}
	if _, _, errRefresh := r.Refresh(context.Background(), time.Second); !errors.Is(errRefresh, ErrDisabled) {
		t.Fatalf("Refresh error = %v, want ErrDisabled", errRefresh)
	}
	history, errHistory := r.History(0, 0)
	if errHistory != nil {
		t.Fatal(errHistory)
	}
	raw, _ := json.Marshal(history)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	if decoded["enabled"] != false || fmt.Sprint(decoded["accounts"]) != "[]" || fmt.Sprint(decoded["samples"]) != "[]" {
		t.Fatalf("disabled history = %s", raw)
	}
	if len(up.requests) != 0 {
		t.Fatalf("disabled recorder made requests: %v", up.requests)
	}
}

func TestRecorderRefreshAndHistory(t *testing.T) {
	up := &fakeUpstream{}
	r := newTestRecorder(t, up)
	now := time.UnixMilli(1731600000000)
	r.now = func() time.Time { return now }
	if errApply := r.Apply(enabledSettings(t)); errApply != nil {
		t.Fatal(errApply)
	}

	n, done, errRefresh := r.Refresh(context.Background(), 10*time.Second)
	if errRefresh != nil || !done || n != 3 {
		t.Fatalf("Refresh = %d, %v, %v; want 3 samples done", n, done, errRefresh)
	}
	for _, header := range up.headers {
		if header["Authorization"] != "Bearer $TOKEN$" {
			t.Fatalf("token placeholder not passed to Doer: %v", header)
		}
	}
	joined := strings.Join(up.requests, "\n")
	if strings.Contains(joined, "codex-off") || strings.Contains(joined, "claude-key") || strings.Contains(joined, "gemini") {
		t.Fatalf("polled ineligible auths:\n%s", joined)
	}

	history, errHistory := r.History(0, 0)
	if errHistory != nil {
		t.Fatal(errHistory)
	}
	raw, errMarshal := json.Marshal(history)
	if errMarshal != nil {
		t.Fatal(errMarshal)
	}
	var decoded struct {
		Enabled         bool             `json:"enabled"`
		IntervalSeconds int64            `json:"interval_seconds"`
		Now             int64            `json:"now"`
		Accounts        []map[string]any `json:"accounts"`
		Samples         []map[string]any `json:"samples"`
	}
	if errUnmarshal := json.Unmarshal(raw, &decoded); errUnmarshal != nil {
		t.Fatal(errUnmarshal)
	}
	if !decoded.Enabled || decoded.IntervalSeconds != 600 || decoded.Now != now.UnixMilli() {
		t.Fatalf("header fields wrong: %s", raw)
	}
	if len(decoded.Accounts) != 4 {
		t.Fatalf("accounts = %v", decoded.Accounts)
	}
	byIndex := map[string]map[string]any{}
	for _, account := range decoded.Accounts {
		for _, key := range []string{"auth_index", "provider", "label", "plan", "disabled"} {
			if _, ok := account[key]; !ok {
				t.Fatalf("account missing %q: %v", key, account)
			}
		}
		byIndex[account["auth_index"].(string)] = account
	}
	if a := byIndex["claude-ok"]; a["label"] != "a@example.com" || a["plan"] != "max_20x" || a["provider"] != "claude" {
		t.Fatalf("claude account = %v", a)
	}
	if a := byIndex["codex-ok"]; a["label"] != "codex label" || a["plan"] != "pro" {
		t.Fatalf("codex account = %v", a)
	}
	if a := byIndex["codex-off"]; a["disabled"] != true {
		t.Fatalf("disabled account = %v", a)
	}

	if len(decoded.Samples) != 3 {
		t.Fatalf("samples = %s", raw)
	}
	samples := map[string]map[string]any{}
	for _, s := range decoded.Samples {
		for _, key := range []string{"t", "auth_index", "windows", "error"} {
			if _, ok := s[key]; !ok {
				t.Fatalf("sample missing %q: %v", key, s)
			}
		}
		if _, leaked := s["plan"]; leaked {
			t.Fatalf("internal plan field leaked: %v", s)
		}
		samples[s["auth_index"].(string)] = s
	}
	broken := samples["claude-broken"]
	if broken["error"] != "HTTP 401: token expired" || fmt.Sprint(broken["windows"]) != "map[]" {
		t.Fatalf("error sample = %v", broken)
	}
	windows := samples["claude-ok"]["windows"].(map[string]any)
	fable := windows[WindowSevenDayFable].(map[string]any)
	if fable["used_percent"] != 55.0 || fable["period_hours"] != 168.0 {
		t.Fatalf("fable window = %v", fable)
	}
	if opus := windows[WindowSevenDayOpus].(map[string]any); opus["resets_at"] != nil {
		t.Fatalf("opus resets_at should be null: %v", opus)
	}
	codex := samples["codex-ok"]["windows"].(map[string]any)
	if five := codex[WindowFiveHour].(map[string]any); five["resets_at"] != 1731610000000.0 || five["period_hours"] != 5.0 {
		t.Fatalf("codex five_hour = %v", five)
	}

	// The Claude profile is fetched once per TTL, not on every poll.
	if _, _, errRefresh = r.Refresh(context.Background(), 10*time.Second); errRefresh != nil {
		t.Fatal(errRefresh)
	}
	profiles := strings.Count(strings.Join(up.requests, "\n"), ClaudeProfileURL)
	if profiles != 1 {
		t.Fatalf("profile fetched %d times", profiles)
	}

	// Time range filters samples.
	future, errFuture := r.History(now.UnixMilli()+1, now.UnixMilli()+2)
	if errFuture != nil || len(future.Samples) != 0 || len(future.Accounts) != 4 {
		t.Fatalf("future range = %+v, %v", future, errFuture)
	}

	// Disabling via Apply stops the recorder.
	if errApply := r.Apply(Settings{Interval: DefaultInterval, Retention: DefaultRetention}); errApply != nil {
		t.Fatal(errApply)
	}
	if r.Enabled() {
		t.Fatal("recorder still enabled")
	}
	if _, _, errRefresh = r.Refresh(context.Background(), time.Second); !errors.Is(errRefresh, ErrDisabled) {
		t.Fatalf("Refresh after disable = %v", errRefresh)
	}
}

func TestRecorderReloadReusesDatabase(t *testing.T) {
	up := &fakeUpstream{}
	r := newTestRecorder(t, up)
	s := enabledSettings(t)
	if errApply := r.Apply(s); errApply != nil {
		t.Fatal(errApply)
	}
	if _, _, errRefresh := r.Refresh(context.Background(), 10*time.Second); errRefresh != nil {
		t.Fatal(errRefresh)
	}
	// Same settings: no-op. Changed interval: restart on the same file.
	if errApply := r.Apply(s); errApply != nil {
		t.Fatal(errApply)
	}
	s.Interval = 2 * DefaultInterval
	if errApply := r.Apply(s); errApply != nil {
		t.Fatal(errApply)
	}
	history, errHistory := r.History(0, 0)
	if errHistory != nil {
		t.Fatal(errHistory)
	}
	if len(history.Samples) != 3 || history.IntervalSeconds != 1200 {
		t.Fatalf("after reload: %d samples, interval %d", len(history.Samples), history.IntervalSeconds)
	}
}

func TestDownsample(t *testing.T) {
	var samples []Sample
	for i := 0; i < 5000; i++ {
		samples = append(samples, Sample{T: int64(i), AuthIndex: "busy"})
		if i%100 == 0 {
			samples = append(samples, Sample{T: int64(i), AuthIndex: "quiet"})
		}
	}
	out := downsample(samples, 2000)
	counts := map[string]int{}
	var lastBusy int64 = -1
	for i, s := range out {
		counts[s.AuthIndex]++
		if i > 0 && s.T < out[i-1].T {
			t.Fatal("order not preserved")
		}
		if s.AuthIndex == "busy" {
			lastBusy = s.T
		}
	}
	if counts["busy"] > 2000 || counts["busy"] < 1000 || counts["quiet"] != 50 || lastBusy != 4999 {
		t.Fatalf("counts = %v, last busy = %d", counts, lastBusy)
	}
}

func TestSettingsFromConfig(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := &config.Config{AuthDir: filepath.Join(dir, "auths")}
	cfg.QuotaHistory = config.QuotaHistoryConfig{Enabled: true}

	s, errSettings := SettingsFromConfig(cfg, cfgPath)
	if errSettings != nil {
		t.Fatal(errSettings)
	}
	if !s.Enabled || s.Interval != DefaultInterval || s.Retention != DefaultRetention || s.Path != filepath.Join(dir, DefaultFileName) {
		t.Fatalf("defaults = %+v", s)
	}

	cfg.QuotaHistory = config.QuotaHistoryConfig{Enabled: true, Interval: "1m", Retention: "7d", Path: "data/qh.db"}
	s, errSettings = SettingsFromConfig(cfg, cfgPath)
	if errSettings != nil {
		t.Fatal(errSettings)
	}
	if s.Interval != MinInterval || s.Retention != 7*24*time.Hour || s.Path != filepath.Join(dir, "data", "qh.db") {
		t.Fatalf("custom = %+v", s)
	}

	cfg.QuotaHistory = config.QuotaHistoryConfig{Enabled: true, Interval: "bogus", Retention: "2h"}
	s, _ = SettingsFromConfig(cfg, cfgPath)
	if s.Interval != DefaultInterval || s.Retention != MinRetention {
		t.Fatalf("fallbacks = %+v", s)
	}

	cfg.QuotaHistory = config.QuotaHistoryConfig{Enabled: true, Path: filepath.Join(dir, "auths", "qh.db")}
	if _, errSettings = SettingsFromConfig(cfg, cfgPath); errSettings == nil {
		t.Fatal("path inside auth-dir must be rejected")
	}
	cfg.QuotaHistory = config.QuotaHistoryConfig{Enabled: true, Path: filepath.Join(dir, "auths-sibling", "qh.db")}
	if _, errSettings = SettingsFromConfig(cfg, cfgPath); errSettings != nil {
		t.Fatalf("sibling dir rejected: %v", errSettings)
	}
}

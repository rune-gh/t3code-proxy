package quotahistory

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/MoeForge/moego/ojson"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
	log "github.com/sirupsen/logrus"
)

// Upstream endpoints and headers, kept identical to the management panel
// (web/src/utils/quota/constants.ts).
const (
	ClaudeUsageURL   = "https://api.anthropic.com/api/oauth/usage"
	ClaudeProfileURL = "https://api.anthropic.com/api/oauth/profile"
	CodexUsageURL    = "https://chatgpt.com/backend-api/wham/usage"
)

func claudeHeaders() map[string]string {
	return map[string]string{
		"User-Agent":     "claude-cli/2.1.280 (external, cli)",
		"Authorization":  "Bearer $TOKEN$",
		"Content-Type":   "application/json",
		"anthropic-beta": "oauth-2025-04-20",
	}
}

func codexHeaders() map[string]string {
	return map[string]string{
		"Authorization": "Bearer $TOKEN$",
		"Content-Type":  "application/json",
		"User-Agent":    "codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)",
	}
}

const (
	requestTimeout       = 20 * time.Second
	defaultScheduledGap  = 3 * time.Second
	defaultManualGap     = 500 * time.Millisecond
	defaultStartupDelay  = 30 * time.Second
	minPollSpacing       = time.Minute
	pruneEvery           = time.Hour
	profileTTL           = 6 * time.Hour
	planSeedRecords      = 5000
	maxErrorMessageBytes = 200

	// MaxSamplesPerAccount caps how many samples one account contributes to a
	// History response; denser ranges are downsampled evenly.
	MaxSamplesPerAccount = 2000
	// DefaultRange is the History range when since is not given.
	DefaultRange = 14 * 24 * time.Hour
)

// ErrDisabled is returned by Refresh when the recorder is not running.
var ErrDisabled = errors.New("quota history is disabled")

// Doer performs one upstream request on behalf of auth. "$TOKEN$" in header
// values must be replaced with the credential's access token. It returns the
// HTTP status and the response body.
type Doer func(ctx context.Context, auth *coreauth.Auth, method, url string, header map[string]string) (int, []byte, error)

// Deps are the host hooks used by the recorder.
type Deps struct {
	// ListAuths returns a snapshot of all known credentials.
	ListAuths func() []*coreauth.Auth
	// Do sends an authenticated request.
	Do Doer
	// Label returns the display label of a credential (optional).
	Label func(*coreauth.Auth) string
}

// Account describes one tracked credential.
type Account struct {
	AuthIndex string `json:"auth_index"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	Plan      string `json:"plan"`
	Disabled  bool   `json:"disabled"`
}

// History is the GET /quota-history response.
type History struct {
	Enabled         bool      `json:"enabled"`
	IntervalSeconds int64     `json:"interval_seconds"`
	Now             int64     `json:"now"`
	Accounts        []Account `json:"accounts"`
	Samples         []Sample  `json:"samples"`
}

type manualPoll struct {
	done    chan struct{}
	samples atomic.Int64
}

// Recorder polls quota on a schedule and serves the recorded history.
type Recorder struct {
	deps Deps
	now  func() time.Time

	scheduledGap time.Duration
	manualGap    time.Duration
	startupDelay time.Duration

	mu       sync.Mutex
	settings Settings
	store    *Store
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup

	// manualMu guards manual; it is only taken alone or after mu.
	manualMu sync.Mutex
	manual   *manualPoll

	pollMu sync.Mutex

	plansMu         sync.Mutex
	plans           map[string]string
	profileAttempts map[string]time.Time
}

// NewRecorder creates a stopped recorder. Call Apply to start it.
func NewRecorder(deps Deps) *Recorder {
	return &Recorder{
		deps:            deps,
		now:             time.Now,
		scheduledGap:    defaultScheduledGap,
		manualGap:       defaultManualGap,
		startupDelay:    defaultStartupDelay,
		settings:        Settings{Interval: DefaultInterval, Retention: DefaultRetention},
		plans:           make(map[string]string),
		profileAttempts: make(map[string]time.Time),
	}
}

// Apply starts, reconfigures or stops the recorder. Unchanged settings are a
// no-op. It never waits on upstream requests beyond cancelling them.
func (r *Recorder) Apply(s Settings) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	running := r.store != nil
	if s == r.settings && running == s.Enabled {
		return nil
	}
	r.stopLocked()
	r.settings = s
	if !s.Enabled {
		return nil
	}
	store, errOpen := OpenStore(s.Path)
	if errOpen != nil {
		return errOpen
	}
	r.plansMu.Lock()
	for idx, plan := range store.latestPlans(planSeedRecords) {
		if r.plans[idx] == "" {
			r.plans[idx] = plan
		}
	}
	r.plansMu.Unlock()
	r.store = store
	r.ctx, r.cancel = context.WithCancel(context.Background())
	r.wg.Add(1)
	go r.run(r.ctx, store, s)
	log.Infof("quota-history: recording every %s to %s (retention %s)", s.Interval, s.Path, s.Retention)
	return nil
}

// Close stops polling and closes the database.
func (r *Recorder) Close() {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopLocked()
}

func (r *Recorder) stopLocked() {
	if r.store == nil {
		return
	}
	r.cancel()
	r.wg.Wait()
	if errClose := r.store.Close(); errClose != nil {
		log.WithError(errClose).Warn("quota-history: close database")
	}
	r.store = nil
	log.Info("quota-history: recorder stopped")
}

// Enabled reports whether the recorder is running.
func (r *Recorder) Enabled() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.store != nil
}

func (r *Recorder) run(ctx context.Context, store *Store, s Settings) {
	defer r.wg.Done()
	r.prune(store, s.Retention)

	delay := r.startupDelay
	if last := store.lastTime(); last > 0 {
		if remaining := s.Interval - r.now().Sub(time.UnixMilli(last)); remaining > delay {
			delay = remaining
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	pruneTicker := time.NewTicker(pruneEvery)
	defer pruneTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-pruneTicker.C:
			r.prune(store, s.Retention)
		case <-timer.C:
			start := time.Now()
			n := r.poll(ctx, store, r.scheduledGap, nil)
			log.Debugf("quota-history: recorded %d samples", n)
			next := s.Interval - time.Since(start)
			if next < minPollSpacing {
				next = minPollSpacing
			}
			timer.Reset(next)
		}
	}
}

func (r *Recorder) prune(store *Store, retention time.Duration) {
	cutoff := r.now().Add(-retention).UnixMilli()
	n, errPrune := store.prune(cutoff)
	if errPrune != nil {
		log.WithError(errPrune).Warn("quota-history: prune failed")
		return
	}
	if n > 0 {
		log.Debugf("quota-history: pruned %d samples", n)
	}
}

// Refresh polls every account now and waits up to wait for the poll to finish.
// Concurrent callers share one in-flight manual poll. It returns the number of
// samples written so far and whether the poll completed.
func (r *Recorder) Refresh(ctx context.Context, wait time.Duration) (int, bool, error) {
	if r == nil {
		return 0, false, ErrDisabled
	}
	r.mu.Lock()
	if r.store == nil {
		r.mu.Unlock()
		return 0, false, ErrDisabled
	}
	r.manualMu.Lock()
	mp := r.manual
	if mp == nil {
		mp = &manualPoll{done: make(chan struct{})}
		r.manual = mp
		store, pollCtx := r.store, r.ctx
		// wg.Add happens under mu so it never races stopLocked's Wait.
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			r.poll(pollCtx, store, r.manualGap, &mp.samples)
			r.manualMu.Lock()
			if r.manual == mp {
				r.manual = nil
			}
			r.manualMu.Unlock()
			close(mp.done)
		}()
	}
	r.manualMu.Unlock()
	r.mu.Unlock()

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-mp.done:
		return int(mp.samples.Load()), true, nil
	case <-timer.C:
	case <-ctx.Done():
	}
	return int(mp.samples.Load()), false, nil
}

// poll samples every enabled account once, sequentially with gap between
// requests, and returns the number of samples stored.
func (r *Recorder) poll(ctx context.Context, store *Store, gap time.Duration, counter *atomic.Int64) int {
	r.pollMu.Lock()
	defer r.pollMu.Unlock()
	stored := 0
	for i, auth := range r.targets() {
		if i > 0 && gap > 0 {
			t := time.NewTimer(gap)
			select {
			case <-ctx.Done():
				t.Stop()
				return stored
			case <-t.C:
			}
		}
		if ctx.Err() != nil {
			return stored
		}
		rec := r.sample(ctx, auth)
		if ctx.Err() != nil {
			// Shutting down or reconfiguring: do not record a cancellation as an error.
			return stored
		}
		if errPut := store.put(rec); errPut != nil {
			log.WithError(errPut).Warn("quota-history: store sample")
			continue
		}
		stored++
		if counter != nil {
			counter.Add(1)
		}
	}
	return stored
}

func (r *Recorder) sample(ctx context.Context, auth *coreauth.Auth) record {
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	rec := record{Sample: Sample{T: r.now().UnixMilli(), AuthIndex: auth.Index, Windows: map[string]Window{}}}
	var windows map[string]Window
	var errFetch error
	switch providerOf(auth) {
	case "claude":
		windows, errFetch = r.fetchClaude(reqCtx, auth)
		if errFetch == nil {
			rec.Plan = r.claudePlan(reqCtx, auth)
		}
	case "codex":
		var plan string
		windows, plan, errFetch = r.fetchCodex(reqCtx, auth)
		if plan == "" {
			plan = metadataString(auth, "plan_type")
		}
		if plan != "" {
			r.setPlan(auth.Index, plan)
		}
		rec.Plan = plan
	}
	if errFetch != nil {
		rec.Error = errFetch.Error()
		log.Debugf("quota-history: %s auth %s: %s", providerOf(auth), auth.Index, rec.Error)
		return rec
	}
	rec.Windows = windows
	return rec
}

func (r *Recorder) fetchClaude(ctx context.Context, auth *coreauth.Auth) (map[string]Window, error) {
	header := claudeHeaders()
	header["Accept"] = "application/json"
	body, errDo := r.get(ctx, auth, ClaudeUsageURL, header)
	if errDo != nil {
		return nil, errDo
	}
	return ParseClaudeUsage(body)
}

// claudePlan returns the cached plan and refreshes it from the profile endpoint
// at most once per profileTTL.
func (r *Recorder) claudePlan(ctx context.Context, auth *coreauth.Auth) string {
	r.plansMu.Lock()
	plan := r.plans[auth.Index]
	last := r.profileAttempts[auth.Index]
	due := last.IsZero() || r.now().Sub(last) >= profileTTL
	if due {
		r.profileAttempts[auth.Index] = r.now()
	}
	r.plansMu.Unlock()
	if !due {
		return plan
	}
	body, errDo := r.get(ctx, auth, ClaudeProfileURL, claudeHeaders())
	if errDo != nil {
		return plan
	}
	if parsed := ParseClaudePlan(body); parsed != "" {
		r.setPlan(auth.Index, parsed)
		return parsed
	}
	return plan
}

func (r *Recorder) fetchCodex(ctx context.Context, auth *coreauth.Auth) (map[string]Window, string, error) {
	header := codexHeaders()
	if accountID := metadataString(auth, "account_id"); accountID != "" {
		header["Chatgpt-Account-Id"] = accountID
	} else if accountID = metadataString(auth, "chatgpt_account_id"); accountID != "" {
		header["Chatgpt-Account-Id"] = accountID
	}
	body, errDo := r.get(ctx, auth, CodexUsageURL, header)
	if errDo != nil {
		return nil, "", errDo
	}
	return ParseCodexUsage(body, r.now())
}

func (r *Recorder) get(ctx context.Context, auth *coreauth.Auth, url string, header map[string]string) ([]byte, error) {
	if r.deps.Do == nil {
		return nil, errors.New("no request transport")
	}
	status, body, errDo := r.deps.Do(ctx, auth, "GET", url, header)
	if errDo != nil {
		return nil, errDo
	}
	if status < 200 || status >= 300 {
		return nil, statusError(status, body)
	}
	return body, nil
}

func statusError(status int, body []byte) error {
	root := ojson.ParseBytes(body)
	msg := firstString(root.Get("error.message"), root.Get("error"), root.Get("message"), root.Get("detail"))
	if len(msg) > maxErrorMessageBytes {
		msg = msg[:maxErrorMessageBytes]
	}
	if msg == "" {
		return fmt.Errorf("HTTP %d", status)
	}
	return fmt.Errorf("HTTP %d: %s", status, msg)
}

func (r *Recorder) setPlan(authIndex, plan string) {
	r.plansMu.Lock()
	r.plans[authIndex] = plan
	r.plansMu.Unlock()
}

func (r *Recorder) plan(authIndex string) string {
	r.plansMu.Lock()
	defer r.plansMu.Unlock()
	return r.plans[authIndex]
}

// History returns the accounts and the samples with since <= t <= until (unix
// ms). since <= 0 means until - DefaultRange; until <= 0 means now.
func (r *Recorder) History(since, until int64) (History, error) {
	now := time.Now()
	if r != nil {
		now = r.now()
	}
	out := History{
		IntervalSeconds: int64(DefaultInterval / time.Second),
		Now:             now.UnixMilli(),
		Accounts:        []Account{},
		Samples:         []Sample{},
	}
	if r == nil {
		return out, nil
	}
	r.mu.Lock()
	store, s := r.store, r.settings
	r.mu.Unlock()
	out.IntervalSeconds = int64(s.Interval / time.Second)
	if store == nil {
		return out, nil
	}
	out.Enabled = true
	if until <= 0 {
		until = out.Now
	}
	if since <= 0 {
		since = until - DefaultRange.Milliseconds()
	}
	out.Accounts = r.accounts()
	errScan := store.scan(since, until, func(rec record) {
		if rec.Windows == nil {
			rec.Windows = map[string]Window{}
		}
		out.Samples = append(out.Samples, rec.Sample)
	})
	if errScan != nil {
		return out, errScan
	}
	out.Samples = downsample(out.Samples, MaxSamplesPerAccount)
	return out, nil
}

// downsample keeps at most max samples per account, evenly spaced and always
// including the newest one. Order is preserved.
func downsample(samples []Sample, max int) []Sample {
	if max < 2 {
		max = 2
	}
	counts := make(map[string]int)
	over := false
	for _, s := range samples {
		counts[s.AuthIndex]++
		if counts[s.AuthIndex] > max {
			over = true
		}
	}
	if !over {
		return samples
	}
	seen := make(map[string]int)
	out := make([]Sample, 0, len(samples))
	for _, s := range samples {
		count := counts[s.AuthIndex]
		i := seen[s.AuthIndex]
		seen[s.AuthIndex]++
		if count <= max {
			out = append(out, s)
			continue
		}
		stride := (count + max - 2) / (max - 1)
		if i%stride == 0 || i == count-1 {
			out = append(out, s)
		}
	}
	return out
}

// accounts lists every Claude/Codex OAuth credential, including disabled ones.
func (r *Recorder) accounts() []Account {
	out := []Account{}
	for _, auth := range r.trackable() {
		plan := r.plan(auth.Index)
		if plan == "" && providerOf(auth) == "codex" {
			plan = metadataString(auth, "plan_type")
		}
		out = append(out, Account{
			AuthIndex: auth.Index,
			Provider:  providerOf(auth),
			Label:     r.label(auth),
			Plan:      plan,
			Disabled:  isDisabled(auth),
		})
	}
	return out
}

// targets lists the credentials polled this round.
func (r *Recorder) targets() []*coreauth.Auth {
	var out []*coreauth.Auth
	for _, auth := range r.trackable() {
		if !isDisabled(auth) {
			out = append(out, auth)
		}
	}
	return out
}

func (r *Recorder) trackable() []*coreauth.Auth {
	if r.deps.ListAuths == nil {
		return nil
	}
	var out []*coreauth.Auth
	for _, auth := range r.deps.ListAuths() {
		if auth == nil {
			continue
		}
		if p := providerOf(auth); p != "claude" && p != "codex" {
			continue
		}
		if auth.AuthKind() == coreauth.AuthKindAPIKey {
			continue
		}
		if auth.EnsureIndex() == "" {
			continue
		}
		out = append(out, auth)
	}
	sort.Slice(out, func(i, j int) bool {
		if pi, pj := providerOf(out[i]), providerOf(out[j]); pi != pj {
			return pi < pj
		}
		return out[i].Index < out[j].Index
	})
	return out
}

func (r *Recorder) label(auth *coreauth.Auth) string {
	if r.deps.Label != nil {
		if label := strings.TrimSpace(r.deps.Label(auth)); label != "" {
			return label
		}
	}
	if email := metadataString(auth, "email"); email != "" {
		return email
	}
	if label := strings.TrimSpace(auth.Label); label != "" {
		return label
	}
	if name := strings.TrimSpace(auth.FileName); name != "" {
		return name
	}
	return auth.ID
}

func providerOf(auth *coreauth.Auth) string {
	return strings.ToLower(strings.TrimSpace(auth.Provider))
}

func isDisabled(auth *coreauth.Auth) bool {
	return auth.Disabled || auth.Status == coreauth.StatusDisabled
}

func metadataString(auth *coreauth.Auth, key string) string {
	if auth == nil || auth.Metadata == nil {
		return ""
	}
	v, _ := auth.Metadata[key].(string)
	return strings.TrimSpace(v)
}

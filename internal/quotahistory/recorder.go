package quotahistory

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
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
	// sampleTimeout bounds one account's usage reads (see AGENTS.md exceptions).
	sampleTimeout       = 45 * time.Second
	defaultScheduledGap = 3 * time.Second
	defaultManualGap    = 500 * time.Millisecond
	defaultStartupDelay = 30 * time.Second
	minPollSpacing      = time.Minute
	pruneEvery          = time.Hour
	profileTTL          = 6 * time.Hour
	planSeedRecords     = 5000

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
	// DoRequest supports provider requests with JSON bodies. Do remains a GET fallback.
	DoRequest func(context.Context, *coreauth.Auth, string, string, map[string]string, []byte) (int, []byte, error)
	// PluginProviders lists providers served by registered quota plugins.
	// The context ends when the recorder stops.
	PluginProviders func(context.Context) map[string]string
	// FetchPlugin uses the host's per-account quota capability and transport.
	FetchPlugin func(context.Context, *coreauth.Auth) ([]byte, error)
	// Label returns the display label of a credential (optional).
	Label func(*coreauth.Auth) string
}

// Account describes one tracked credential.
type Account struct {
	AuthIndex string `json:"auth_index"`
	Provider  string `json:"provider"`
	Label     string `json:"label"`
	Plan      string `json:"plan"`
	// Weight is the plan capacity routing uses for this account (1 = base plan).
	Weight   float64 `json:"weight"`
	Disabled bool    `json:"disabled"`
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

	pollMu    sync.Mutex
	providers atomic.Value // normalized comma-separated provider allowlist
	// pluginIDs is the last plugin discovery; nil until the first poll.
	pluginIDs atomic.Pointer[map[string]string]

	plansMu         sync.Mutex
	plans           map[string]string
	profileAttempts map[string]time.Time
	// customers maps a Mistral key's auth index to its customer fingerprint.
	customers        map[string]string
	customerAttempts map[string]time.Time
}

// NewRecorder creates a stopped recorder. Call Apply to start it.
func NewRecorder(deps Deps) *Recorder {
	return &Recorder{
		deps:             deps,
		now:              time.Now,
		scheduledGap:     defaultScheduledGap,
		manualGap:        defaultManualGap,
		startupDelay:     defaultStartupDelay,
		settings:         Settings{Interval: DefaultInterval, Retention: DefaultRetention},
		plans:            make(map[string]string),
		profileAttempts:  make(map[string]time.Time),
		customers:        make(map[string]string),
		customerAttempts: make(map[string]time.Time),
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
	r.providers.Store(s.Providers)
	r.forgetUntracked(s.Enabled)
	r.pluginIDs.Store(nil)
	if !s.Enabled {
		return nil
	}
	store, errOpen := OpenStore(s.Path)
	if errOpen != nil {
		// Nothing will poll, so no reading may keep steering routing.
		r.forgetUntracked(false)
		return errOpen
	}
	customers, errCustomers := store.mistralCustomers()
	if errCustomers != nil {
		log.WithError(errCustomers).Warn("quota-history: restore Mistral customers")
	}
	r.plansMu.Lock()
	// Seed a new database even for known keys that are no longer polled.
	if errSave := store.putMistralCustomers(r.customers); errSave != nil {
		log.WithError(errSave).Warn("quota-history: seed Mistral customers")
	}
	for idx, customer := range customers {
		if r.customers[idx] == "" {
			r.customers[idx] = customer
		}
	}
	for idx, plan := range store.latestPlans(planSeedRecords) {
		if r.plans[idx] == "" {
			r.plans[idx] = plan
		}
	}
	r.plansMu.Unlock()
	r.store = store
	r.ctx, r.cancel = context.WithCancel(context.Background())
	// Routing learns stored plans now instead of after the first poll.
	for _, auth := range r.trackable(nil) {
		if plan := r.plan(auth.Index); plan != "" && providerOf(auth) != "mistral" {
			coreauth.ObserveAuthPlan(auth.ID, plan)
		}
	}
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
	for i, auth := range r.targets(ctx) {
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
		// The target list was taken when the round started. Read the account
		// again so one disabled or removed meanwhile is not polled, and a token
		// refresh does not write back a stale copy.
		if auth = r.current(auth.ID); auth == nil || isDisabled(auth) {
			continue
		}
		rec := r.sample(ctx, auth)
		mistral := providerOf(auth) == "mistral"
		if mistral {
			// Keep verified identities even if cancellation discards the usage sample.
			r.plansMu.Lock()
			customer := r.customers[auth.Index]
			r.plansMu.Unlock()
			if customer != "" {
				if errPut := store.putMistralCustomers(map[string]string{auth.Index: customer}); errPut != nil {
					log.WithError(errPut).Warn("quota-history: store Mistral customer")
				}
			}
		}
		if ctx.Err() != nil {
			// Shutting down or reconfiguring: do not record a cancellation as an error.
			return stored
		}
		if mistral && r.mistralDuplicates(r.trackable(r.pluginProviders(ctx, false)))[auth.Index] {
			continue
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
	// One provider that accepts the connection and never answers must not stop
	// recording for every other account.
	ctx, cancel := context.WithTimeout(ctx, sampleTimeout)
	defer cancel()
	rec := record{Sample: Sample{T: r.now().UnixMilli(), AuthIndex: auth.Index, Windows: map[string]Window{}}}
	poll := providerPollers[providerOf(auth)]
	if poll == nil {
		poll = (*Recorder).fetchPlugin
	}
	windows, plan, errFetch := poll(r, ctx, auth)
	if errFetch != nil {
		rec.Error = errFetch.Error()
		log.Debugf("quota-history: %s auth %s: %s", providerOf(auth), auth.Index, rec.Error)
		return rec
	}
	rec.Windows = windows
	rec.Plan = plan
	if plan != "" {
		r.setPlan(auth.Index, plan)
	}
	// Mistral's API and Vibe budgets fund separate request types. History keeps
	// both allowances, while account-wide routing cannot identify which applies.
	if providerOf(auth) == "mistral" {
		return rec
	}
	r.publishRouting(auth, plan, windows, time.UnixMilli(rec.T))
	observations := make([]coreauth.QuotaWindow, 0, len(windows))
	for key, window := range windows {
		// A usage figure the parser had to assume is charted but does not steer routing.
		if window.ResetsAt == nil || window.PeriodHours <= 0 || window.estimated {
			continue
		}
		scope := window.modelScope
		if family, scoped := strings.CutPrefix(key, WindowSevenDay+"_"); providerOf(auth) == "claude" && scoped {
			scope = []string{"*-" + family + "-*", "*-" + family}
		}
		observations = append(observations, coreauth.QuotaWindow{Key: key, UsedPercent: window.UsedPercent,
			ResetAt: time.UnixMilli(*window.ResetsAt), Period: time.Duration(window.PeriodHours * float64(time.Hour)), ModelScope: scope})
	}
	coreauth.ObserveQuotaWindows(auth.ID, time.UnixMilli(rec.T), observations)
	if providerOf(auth) == "claude" {
		coreauth.ObserveScopedWeeklyWindows(auth.ID, time.UnixMilli(rec.T), scopedWeeklyWindows(windows))
	}
	return rec
}

// publishRouting hands routing the plan and 5-hour reading of one account, so
// plan weights and the headroom guard use what the recorder already fetched.
func (r *Recorder) publishRouting(auth *coreauth.Auth, plan string, windows map[string]Window, observedAt time.Time) {
	if plan == "" {
		plan = r.plan(auth.Index)
	}
	if plan != "" {
		coreauth.ObserveAuthPlan(auth.ID, plan)
	}
	window, ok := windows[WindowFiveHour]
	if !ok || window.estimated {
		return
	}
	var resetAt time.Time
	if window.ResetsAt != nil && *window.ResetsAt > 0 {
		resetAt = time.UnixMilli(*window.ResetsAt)
	}
	coreauth.ObserveShortWindowUsage(auth.ID, observedAt, window.UsedPercent, resetAt)
}

// scopedWeeklyWindows extracts the model-scoped weekly caps ("seven_day_<family>")
// keyed by family token, for the soonest-reset-first selector.
func scopedWeeklyWindows(windows map[string]Window) map[string]coreauth.ScopedWeeklyWindow {
	out := make(map[string]coreauth.ScopedWeeklyWindow)
	for id, w := range windows {
		family, ok := strings.CutPrefix(id, WindowSevenDay+"_")
		if !ok || family == "" || w.ResetsAt == nil {
			continue
		}
		out[family] = coreauth.ScopedWeeklyWindow{UsedPercent: w.UsedPercent, ResetAt: time.UnixMilli(*w.ResetsAt)}
	}
	return out
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
	return r.cachedPlan(auth, func() string {
		body, errDo := r.get(ctx, auth, ClaudeProfileURL, claudeHeaders())
		if errDo != nil {
			return ""
		}
		return ParseClaudePlan(body)
	})
}

// cachedPlan returns the plan last learned for an account and asks fetch for a
// fresh one at most once per profileTTL. A failed or empty fetch keeps the
// stored plan, so an outage of the plan endpoint does not erase a known plan.
// While no plan is known at all, the fetch is retried on the next poll.
func (r *Recorder) cachedPlan(auth *coreauth.Auth, fetch func() string) string {
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
	if fetched := strings.TrimSpace(fetch()); fetched != "" {
		r.setPlan(auth.Index, fetched)
		return fetched
	}
	if plan == "" {
		r.plansMu.Lock()
		delete(r.profileAttempts, auth.Index)
		r.plansMu.Unlock()
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
	return r.request(ctx, auth, "GET", url, header, nil)
}

func (r *Recorder) request(ctx context.Context, auth *coreauth.Auth, method, url string, header map[string]string, data []byte) ([]byte, error) {
	var status int
	var body []byte
	var errDo error
	if r.deps.DoRequest != nil {
		status, body, errDo = r.deps.DoRequest(ctx, auth, method, url, header, data)
	} else if r.deps.Do != nil && len(data) == 0 {
		status, body, errDo = r.deps.Do(ctx, auth, method, url, header)
	} else {
		return nil, errors.New("no request transport")
	}
	if errDo != nil {
		return nil, errDo
	}
	if status < 200 || status >= 300 {
		// Usage responses can echo credentials or personal data. Keep errors bounded
		// to the status code for both storage and logs.
		return nil, fmt.Errorf("HTTP %d", status)
	}
	return body, nil
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
	listed := make(map[string]bool, len(out.Accounts))
	for _, account := range out.Accounts {
		listed[account.AuthIndex] = true
	}
	duplicates := r.mistralDuplicates(r.trackable(r.pluginProviders(context.Background(), false)))
	errScan := store.scan(since, until, func(rec record) {
		if duplicates[rec.AuthIndex] && !listed[rec.AuthIndex] {
			return
		}
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

// accounts lists supported subscription credentials, including disabled ones.
func (r *Recorder) accounts() []Account {
	out := []Account{}
	auths := r.trackable(r.pluginProviders(context.Background(), false))
	duplicates := r.mistralDuplicates(auths)
	for _, auth := range auths {
		if duplicates[auth.Index] {
			continue
		}
		plan := r.plan(auth.Index)
		if plan == "" {
			plan = coreauth.PlanOf(auth)
		}
		weight := 1.0
		if providerOf(auth) != "mistral" {
			weight = coreauth.PlanWeight(providerOf(auth), plan)
		}
		out = append(out, Account{
			AuthIndex: auth.Index,
			Provider:  providerOf(auth),
			Label:     r.label(auth),
			Plan:      plan,
			Weight:    weight,
			Disabled:  isDisabled(auth),
		})
	}
	return out
}

// targets lists the credentials polled this round and refreshes the list of
// quota-plugin providers.
func (r *Recorder) targets(ctx context.Context) []*coreauth.Auth {
	var out []*coreauth.Auth
	for _, auth := range r.trackable(r.pluginProviders(ctx, true)) {
		if !isDisabled(auth) {
			out = append(out, auth)
		}
	}
	return out
}

// pluginProviders returns the providers served by quota plugins. Only polls
// ask the plugins, with the recorder's context, so a slow plugin cannot
// outlive a shutdown or hold up a history request; history requests reuse the
// last list, which is empty until the first poll. Plugins are not asked at all
// when the provider allowlist names only built-in providers.
func (r *Recorder) pluginProviders(ctx context.Context, refresh bool) map[string]string {
	if r.deps.PluginProviders == nil {
		return nil
	}
	if !refresh {
		if cached := r.pluginIDs.Load(); cached != nil {
			return *cached
		}
		return nil
	}
	providers, _ := r.providers.Load().(string)
	wanted := providers == ""
	for _, name := range strings.Split(providers, ",") {
		wanted = wanted || (name != "" && providerPollers[name] == nil)
	}
	found := map[string]string{}
	if wanted {
		for provider, id := range r.deps.PluginProviders(ctx) {
			found[provider] = id
		}
	}
	r.pluginIDs.Store(&found)
	return found
}

// forgetUntracked drops the routing readings of accounts the recorder no
// longer polls, because the recorder was turned off or the provider left the
// allowlist. Otherwise a last "spent" reading would keep steering routing until
// its window resets.
func (r *Recorder) forgetUntracked(enabled bool) {
	if r.deps.ListAuths == nil {
		return
	}
	tracked := make(map[string]bool)
	if enabled {
		// The last plugin list keeps plugin-provider accounts tracked across a
		// settings change; trackable applies the new allowlist to them.
		for _, auth := range r.trackable(r.pluginProviders(context.Background(), false)) {
			tracked[auth.ID] = true
		}
	}
	for _, auth := range r.deps.ListAuths() {
		if auth == nil || tracked[auth.ID] {
			continue
		}
		coreauth.ForgetQuotaWindows(auth.ID)
		coreauth.ForgetScopedWeeklyWindows(auth.ID)
		coreauth.ForgetShortWindowUsage(auth.ID)
		// The plan falls back to response headers and the credential's own fields.
		coreauth.ObserveAuthPlan(auth.ID, "")
	}
}

// current returns the live copy of an account, or nil when it is gone.
func (r *Recorder) current(id string) *coreauth.Auth {
	if r.deps.ListAuths == nil {
		return nil
	}
	for _, auth := range r.deps.ListAuths() {
		if auth != nil && auth.ID == id {
			return auth
		}
	}
	return nil
}

func (r *Recorder) trackable(plugins map[string]string) []*coreauth.Auth {
	if r.deps.ListAuths == nil {
		return nil
	}
	var out []*coreauth.Auth
	providers, _ := r.providers.Load().(string)
	for _, auth := range r.deps.ListAuths() {
		if auth == nil {
			continue
		}
		p := providerOf(auth)
		if providerPollers[p] == nil && plugins[p] == "" {
			continue
		}
		if providers != "" && !strings.Contains(","+providers+",", ","+p+",") {
			continue
		}
		if auth.AuthKind() == coreauth.AuthKindAPIKey && (p == "claude" || p == "codex" || p == "xai") {
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
	if providerOf(auth) == "mistral" {
		if name := strings.TrimSpace(auth.Attributes["compat_name"]); name != "" {
			return name
		}
		return "Mistral"
	}
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
	if auth.AuthKind() == coreauth.AuthKindAPIKey {
		base, err := url.Parse(strings.TrimSpace(auth.Attributes["base_url"]))
		if err == nil && strings.EqualFold(base.Hostname(), "api.mistral.ai") {
			return "mistral"
		}
	}
	provider := strings.ToLower(strings.TrimSpace(auth.Provider))
	// The billing poller requires Mistral's own host and an API key, even when
	// another upstream happens to use the same provider name.
	if provider == "mistral" {
		return ""
	}
	return provider
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

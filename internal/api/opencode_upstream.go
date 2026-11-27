package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/MoeForge/moego/ojson"
	log "github.com/sirupsen/logrus"
)

// OPENCODE_MODELS_URL replaces OpenCode's whole models.dev catalog, so pointing
// it at the hub would hide OpenCode's own "opencode" provider: OpenCode Zen and
// the free models OpenCode offers without a login. The hub copies that provider
// from models.dev into its catalog unchanged. OpenCode keeps calling opencode.ai
// for those models itself; the hub never proxies them.

const (
	openCodeUpstreamCatalogURL = "https://models.dev/api.json"
	openCodeUpstreamProviderID = "opencode"

	openCodeUpstreamTTL        = time.Hour
	openCodeUpstreamRetryAfter = 5 * time.Minute
	// openCodeUpstreamFirstWait bounds how long a catalog request waits for the
	// very first copy. The fetch itself keeps running; OpenCode picks the
	// provider up on its next refresh.
	openCodeUpstreamFirstWait = 5 * time.Second
)

type openCodeUpstreamCatalog struct {
	url   string
	fetch func(ctx context.Context, url string) ([]byte, error)
	now   func() time.Time

	mu       sync.Mutex
	provider json.RawMessage
	next     time.Time
	inflight chan struct{}
}

var openCodeUpstream = newOpenCodeUpstreamCatalog(openCodeUpstreamCatalogURL, fetchOpenCodeUpstreamCatalog)

func newOpenCodeUpstreamCatalog(url string, fetch func(context.Context, string) ([]byte, error)) *openCodeUpstreamCatalog {
	return &openCodeUpstreamCatalog{url: url, fetch: fetch, now: time.Now}
}

// Provider returns the cached "opencode" provider, or nil before the first
// successful fetch. A stale copy is served while a refresh runs.
func (u *openCodeUpstreamCatalog) Provider(firstWait time.Duration) json.RawMessage {
	u.mu.Lock()
	if u.inflight == nil && !u.now().Before(u.next) {
		u.inflight = make(chan struct{})
		go u.refresh(u.inflight)
	}
	provider, inflight := u.provider, u.inflight
	u.mu.Unlock()
	if provider != nil || inflight == nil || firstWait <= 0 {
		return provider
	}

	timer := time.NewTimer(firstWait)
	defer timer.Stop()
	select {
	case <-inflight:
	case <-timer.C:
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.provider
}

func (u *openCodeUpstreamCatalog) refresh(done chan struct{}) {
	provider, err := u.load()
	u.mu.Lock()
	if err != nil {
		log.Warnf("opencode catalog: keeping the previous OpenCode provider: %v", err)
		u.next = u.now().Add(openCodeUpstreamRetryAfter)
	} else {
		u.provider = provider
		u.next = u.now().Add(openCodeUpstreamTTL)
	}
	u.inflight = nil
	u.mu.Unlock()
	close(done)
}

func (u *openCodeUpstreamCatalog) load() (json.RawMessage, error) {
	body, err := u.fetch(context.Background(), u.url)
	if err != nil {
		return nil, err
	}
	provider := ojson.GetBytes(body, openCodeUpstreamProviderID)
	if !provider.IsObject() || !provider.Get("models").IsObject() {
		return nil, fmt.Errorf("%s has no %q provider", u.url, openCodeUpstreamProviderID)
	}
	return json.RawMessage(provider.Raw), nil
}

func fetchOpenCodeUpstreamCatalog(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", url, err)
	}
	defer func() {
		if errClose := resp.Body.Close(); errClose != nil {
			log.Errorf("opencode catalog: close response body: %v", errClose)
		}
	}()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", url, err)
	}
	return body, nil
}

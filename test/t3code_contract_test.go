package test

// Contract tests for T3 Code, a desktop app that reads pooled limits from this
// hub through the management API. T3 Code cannot be changed, so these tests pin
// the request and response shapes it depends on:
//
//   - GET  /v0/management/auth-files  -> {"files":[{id, auth_index, provider, email?, disabled?, project_id?, id_token?}]}
//   - POST /v0/management/api-call    -> {"status_code":n,"body":"..."}, "$TOKEN$" replaced in header values
//   - POST /v0/management/reset-quota -> clears the account's cooldown
//
// Every request sends "Authorization: Bearer <management key>".

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MoeForge/moego/base64"
	"github.com/MoeForge/moego/ojson"
	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/api"
	"github.com/rune-oai/t3code-proxy/internal/config"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

const t3ManagementKey = "t3-contract-key"

type t3Hub struct {
	handler http.Handler
	manager *coreauth.Manager
}

func newT3Hub(t *testing.T) *t3Hub {
	t.Helper()
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	raw := "port: 8317\nauth-dir: " + filepath.Join(dir, "auths") + "\nremote-management:\n  allow-remote: true\n  secret-key: " + t3ManagementKey + "\n"
	if errWrite := os.WriteFile(path, []byte(raw), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	cfg, errLoad := config.LoadConfig(path)
	if errLoad != nil {
		t.Fatal(errLoad)
	}
	manager := coreauth.NewManager(nil, nil, nil)
	idToken := "e30." + base64.RawURLEncoding.EncodeToString([]byte(`{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-123","chatgpt_plan_type":"pro"}}`)) + ".sig"
	runtime := func(extra map[string]string) map[string]string {
		attrs := map[string]string{"runtime_only": "true"}
		for k, v := range extra {
			attrs[k] = v
		}
		return attrs
	}
	for _, auth := range []*coreauth.Auth{
		{ID: "t3-codex", Provider: "codex", Status: coreauth.StatusActive, Attributes: runtime(nil),
			Metadata: map[string]any{"email": "codex@example.com", "access_token": "tok-codex", "id_token": idToken}},
		{ID: "t3-claude", Provider: "claude", Status: coreauth.StatusActive, Attributes: runtime(nil),
			Metadata: map[string]any{"email": "claude@example.com", "access_token": "tok-claude"}},
		{ID: "t3-antigravity", Provider: "antigravity", Status: coreauth.StatusActive, Attributes: runtime(nil),
			Metadata: map[string]any{"email": "ag@example.com", "project_id": "proj-42", "access_token": "tok-ag", "expired": time.Now().Add(time.Hour).Format(time.RFC3339)}},
		{ID: "t3-xai", Provider: "xai", Status: coreauth.StatusActive, Attributes: runtime(nil),
			Metadata: map[string]any{"email": "xai@example.com", "access_token": "tok-xai"}},
	} {
		if _, errRegister := manager.Register(context.Background(), auth); errRegister != nil {
			t.Fatal(errRegister)
		}
	}
	server := api.NewServer(cfg, manager, nil, path)
	return &t3Hub{handler: server.Handler(), manager: manager}
}

// do sends a request as a remote T3 Code client would.
func (h *t3Hub) do(t *testing.T, method, path, key, body string) (int, ojson.Result) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "192.0.2.10:5555"
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec.Code, ojson.ParseBytes(rec.Body.Bytes())
}

func (h *t3Hub) authIndex(t *testing.T, id string) string {
	t.Helper()
	auth, ok := h.manager.GetByID(id)
	if !ok {
		t.Fatalf("auth %s not registered", id)
	}
	return auth.EnsureIndex()
}

func TestT3CodeContractRejectsBadManagementKey(t *testing.T) {
	for _, route := range []struct{ method, path, body string }{
		{http.MethodGet, "/v0/management/auth-files", ""},
		{http.MethodPost, "/v0/management/api-call", `{"auth_index":"x","method":"GET","url":"http://127.0.0.1:1/","header":{}}`},
		{http.MethodPost, "/v0/management/reset-quota", `{"auth_index":"x"}`},
	} {
		// A fresh hub per route: five failed attempts from one IP ban it (403).
		hub := newT3Hub(t)
		for _, key := range []string{"", "wrong-key"} {
			status, _ := hub.do(t, route.method, route.path, key, route.body)
			if status != http.StatusUnauthorized {
				t.Errorf("%s %s key=%q: status=%d, want 401", route.method, route.path, key, status)
			}
		}
	}
}

func TestT3CodeContractAuthFiles(t *testing.T) {
	hub := newT3Hub(t)
	status, root := hub.do(t, http.MethodGet, "/v0/management/auth-files", t3ManagementKey, "")
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, root.Raw)
	}
	files := root.Get("files")
	if !files.IsArray() {
		t.Fatalf("files is not an array: %s", root.Raw)
	}
	byID := map[string]ojson.Result{}
	for _, file := range files.Array() {
		for _, key := range []string{"id", "auth_index", "provider"} {
			if file.Get(key).Type != ojson.String || file.Get(key).String() == "" {
				t.Errorf("file %s: %s must be a non-empty string", file.Raw, key)
			}
		}
		for key, want := range map[string]ojson.Type{"email": ojson.String, "project_id": ojson.String} {
			if v := file.Get(key); v.Exists() && v.Type != want {
				t.Errorf("file %s: %s has type %v", file.Get("id").String(), key, v.Type)
			}
		}
		if v := file.Get("disabled"); v.Exists() && v.Type != ojson.True && v.Type != ojson.False {
			t.Errorf("file %s: disabled must be boolean", file.Get("id").String())
		}
		byID[file.Get("id").String()] = file
	}
	for id, provider := range map[string]string{"t3-codex": "codex", "t3-claude": "claude", "t3-xai": "xai", "t3-antigravity": "antigravity"} {
		file, ok := byID[id]
		if !ok {
			t.Fatalf("auth %s missing from files: %s", id, files.Raw)
		}
		if got := file.Get("provider").String(); got != provider {
			t.Errorf("%s provider=%q, want %q", id, got, provider)
		}
		if got := file.Get("auth_index").String(); got != hub.authIndex(t, id) {
			t.Errorf("%s auth_index=%q, want %q", id, got, hub.authIndex(t, id))
		}
	}
	if got := byID["t3-claude"].Get("email").String(); got != "claude@example.com" {
		t.Errorf("claude email=%q", got)
	}
	if got := byID["t3-antigravity"].Get("project_id").String(); got != "proj-42" {
		t.Errorf("antigravity project_id=%q", got)
	}
	idToken := byID["t3-codex"].Get("id_token")
	if !idToken.IsObject() || idToken.Get("chatgpt_account_id").String() != "acct-123" {
		t.Errorf("codex id_token.chatgpt_account_id missing: %s", idToken.Raw)
	}
	// T3 Code accepts either id_token.chatgpt_plan_type or id_token.plan_type;
	// the hub emits the plan under plan_type.
	if plan := idToken.Get("plan_type").String() + idToken.Get("chatgpt_plan_type").String(); plan != "pro" {
		t.Errorf("codex id_token plan missing: %s", idToken.Raw)
	}
}

func TestT3CodeContractAPICallSubstitutesToken(t *testing.T) {
	hub := newT3Hub(t)
	type seen struct{ method, auth, extra, body string }
	var mu sync.Mutex
	var requests []seen
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests = append(requests, seen{r.Method, r.Header.Get("Authorization"), r.Header.Get("X-Extra"), string(body)})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, `{"five_hour":{"utilization":12}}`)
	}))
	defer upstream.Close()

	for _, tc := range []struct {
		id, method, data, wantToken string
	}{
		{"t3-claude", "GET", "", "tok-claude"},
		{"t3-codex", "POST", `{"probe":true}`, "tok-codex"},
	} {
		body := `{"auth_index":"` + hub.authIndex(t, tc.id) + `","method":"` + tc.method + `","url":"` + upstream.URL + `/usage","header":{"Authorization":"Bearer $TOKEN$","X-Extra":"plain"}`
		if tc.data != "" {
			body += `,"data":` + string(ojson.AppendJSONString(nil, tc.data))
		}
		body += `}`
		status, root := hub.do(t, http.MethodPost, "/v0/management/api-call", t3ManagementKey, body)
		if status != http.StatusOK {
			t.Fatalf("%s: status=%d body=%s", tc.id, status, root.Raw)
		}
		if root.Get("status_code").Type != ojson.Number || root.Get("status_code").Int() != http.StatusTeapot {
			t.Errorf("%s: status_code=%s, want 418 number", tc.id, root.Get("status_code").Raw)
		}
		if root.Get("body").Type != ojson.String || root.Get("body").String() != `{"five_hour":{"utilization":12}}` {
			t.Errorf("%s: body=%s, want upstream body as string", tc.id, root.Get("body").Raw)
		}
		mu.Lock()
		last := requests[len(requests)-1]
		mu.Unlock()
		if last.method != tc.method || last.auth != "Bearer "+tc.wantToken || last.extra != "plain" || last.body != tc.data {
			t.Errorf("%s: upstream saw %+v", tc.id, last)
		}
	}
}

func TestT3CodeContractResetQuotaClearsCooldown(t *testing.T) {
	hub := newT3Hub(t)
	auth, _ := hub.manager.GetByID("t3-claude")
	future := time.Now().Add(3 * time.Hour)
	auth.Unavailable = true
	auth.Status = coreauth.StatusError
	auth.NextRetryAfter = future
	auth.Quota = coreauth.QuotaState{Exceeded: true, Reason: "credential_quota", NextRecoverAt: future}
	if _, errUpdate := hub.manager.Update(context.Background(), auth); errUpdate != nil {
		t.Fatal(errUpdate)
	}
	if cooled, _ := hub.manager.GetByID("t3-claude"); !cooled.Quota.Exceeded {
		t.Fatalf("precondition: cooldown not stored: %+v", cooled.Quota)
	}
	status, root := hub.do(t, http.MethodPost, "/v0/management/reset-quota", t3ManagementKey, `{"auth_index":"`+hub.authIndex(t, "t3-claude")+`"}`)
	if status != http.StatusOK {
		t.Fatalf("status=%d body=%s", status, root.Raw)
	}
	reset, _ := hub.manager.GetByID("t3-claude")
	if reset.Quota.Exceeded || reset.Unavailable || reset.NextRetryAfter.After(time.Now()) {
		t.Fatalf("cooldown not cleared: unavailable=%v next=%v quota=%+v", reset.Unavailable, reset.NextRetryAfter, reset.Quota)
	}
	if status, _ = hub.do(t, http.MethodPost, "/v0/management/reset-quota", t3ManagementKey, `{"auth_index":"missing"}`); status != http.StatusNotFound {
		t.Errorf("unknown auth_index status=%d, want 404", status)
	}
}

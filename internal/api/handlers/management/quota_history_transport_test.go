package management

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/pluginhost"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	"github.com/rune-oai/t3code-proxy/sdk/pluginapi"
)

func TestQuotaHistoryPostTransport(t *testing.T) {
	// net.Pipe exercises the HTTP transport without opening a network socket.
	type captured struct {
		authorization, body string
		err                 error
	}
	received := make(chan captured, 1)
	transport := &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) {
		client, server := net.Pipe()
		go func() {
			defer func() {
				if err := server.Close(); err != nil {
					t.Errorf("close pipe: %v", err)
				}
			}()
			req, err := http.ReadRequest(bufio.NewReader(server))
			if err != nil {
				received <- captured{err: err}
				return
			}
			body, errRead := io.ReadAll(req.Body)
			if errClose := req.Body.Close(); errClose != nil {
				t.Errorf("close request: %v", errClose)
			}
			received <- captured{authorization: req.Header.Get("Authorization"), body: string(body), err: errRead}
			if _, errWrite := fmt.Fprint(server, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"); errWrite != nil {
				t.Errorf("write response: %v", errWrite)
			}
		}()
		return client, nil
	}}
	previous := http.DefaultTransport
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = previous; transport.CloseIdleConnections() })
	handler := NewHandler(&config.Config{}, "", nil)
	for _, tc := range []struct{ provider, token, authorization, body string }{
		{"devin", "fixture-\"-\\-token", "", `{"metadata":{"apiKey":"$TOKEN$"}}`},
		{"meta", "", "Bearer dca:fixture", `{}`},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			auth := &coreauth.Auth{ID: tc.provider, Provider: tc.provider, Metadata: map[string]any{"session_token": tc.token}}
			headers := map[string]string{"Content-Type": "application/json"}
			if tc.authorization != "" {
				headers["Authorization"] = tc.authorization
			}
			status, _, err := handler.quotaHistoryRequest(context.Background(), auth, http.MethodPost, "http://quota.invalid/usage", headers, []byte(tc.body))
			if err != nil || status != 200 {
				t.Fatalf("request = %d %v", status, err)
			}
			got := <-received
			if got.err != nil {
				t.Fatal(got.err)
			}
			if got.authorization != tc.authorization {
				t.Fatalf("authorization = %q", got.authorization)
			}
			if tc.provider == "devin" && ojson.Get(got.body, "metadata.apiKey").String() != tc.token {
				t.Fatalf("invalid JSON token substitution %q", got.body)
			}
			if strings.Contains(got.body, "$TOKEN$") {
				t.Fatal("unresolved token placeholder")
			}
		})
	}
}

func TestQuotaHistoryPluginUsesHostCapability(t *testing.T) {
	host := pluginhost.New()
	host.RegisterPluginForTest("fixture-plugin", pluginapi.Plugin{Capabilities: pluginapi.Capabilities{QuotaProvider: &mockQuotaProvider{
		identifier: "fixture-provider",
		fetchFn: func(_ context.Context, req pluginapi.QuotaFetchRequest) (pluginapi.QuotaFetchResponse, error) {
			if req.AuthID != "fixture-auth" || req.AuthIndex != "fixture-index" || req.Metadata["token"] != "fixture-token" || req.HTTPClient == nil {
				t.Fatalf("missing account context or host HTTP client")
			}
			return pluginapi.QuotaFetchResponse{Subscription: &pluginapi.QuotaSubscription{Plan: "fixture-plan"}, Groups: []pluginapi.QuotaGroup{{DisplayName: "Account", Buckets: []pluginapi.QuotaBucket{{Window: "weekly", RemainingFraction: 0.25, ResetTime: "2026-11-20T00:00:00Z"}}}}}, nil
		},
	}}})
	handler := NewHandler(&config.Config{}, "", nil)
	handler.SetPluginHost(host)
	if got := handler.quotaHistoryPluginProviders(context.Background())["fixture-provider"]; got != "fixture-plugin" {
		t.Fatalf("quota plugin = %q", got)
	}
	body, err := handler.quotaHistoryPlugin(context.Background(), &coreauth.Auth{ID: "fixture-auth", Index: "fixture-index", Provider: "fixture-provider", Metadata: map[string]any{"token": "fixture-token"}})
	if err != nil {
		t.Fatal(err)
	}
	root := ojson.ParseBytes(body)
	if root.Get("subscription.plan").String() != "fixture-plan" || root.Get("groups.0.buckets.0.remainingFraction").Float() != 0.25 {
		t.Fatalf("quota = %s", body)
	}
}

// A usage read never starts its own OAuth refresh: an account whose token is
// due is reported and left to the hub's refresh loop.
func TestQuotaHistoryRequestLeavesTokenRefreshToTheHub(t *testing.T) {
	expired := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	fresh := time.Now().Add(6 * time.Hour).UTC().Format(time.RFC3339)
	due := &coreauth.Auth{ID: "agy-due", Provider: "antigravity", Metadata: map[string]any{"access_token": "old", "refresh_token": "r", "expired": expired}}
	if !quotaHistoryTokenRefreshDue(due) {
		t.Fatal("an expired Antigravity token must be reported as due")
	}
	ok := &coreauth.Auth{ID: "agy-ok", Provider: "antigravity", Metadata: map[string]any{"access_token": "new", "refresh_token": "r", "expired": fresh}}
	if quotaHistoryTokenRefreshDue(ok) {
		t.Fatal("a fresh Antigravity token must not be reported as due")
	}
	if quotaHistoryTokenRefreshDue(&coreauth.Auth{ID: "claude", Provider: "claude", Metadata: map[string]any{"access_token": "x"}}) {
		t.Fatal("providers that do not refresh on this path are never due")
	}
	handler := &Handler{}
	if _, _, err := handler.quotaHistoryRequest(context.Background(), due, "GET", "http://127.0.0.1:1/unreachable", map[string]string{"Authorization": "Bearer $TOKEN$"}, nil); err == nil || err.Error() != "token refresh due" {
		t.Fatalf("err = %v, want token refresh due without any request", err)
	}
}

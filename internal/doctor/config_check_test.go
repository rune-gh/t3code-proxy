package doctor

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MoeForge/moego/ojson"
)

func TestConfigCheckLeavesSourceAndAuthUntouched(t *testing.T) {
	dir := t.TempDir()
	auth := filepath.Join(dir, "auth") // Deliberately absent. Validation must not create it.
	path := filepath.Join(dir, "config.yaml")
	source := fmt.Sprintf(`config-version: 8
server: {host: 127.0.0.1, port: 8317}
management: {secret-key: never-print-management}
access: {api-keys: [never-print-access]}
oauth: {auth-dir: %q}
patched-build-setting: never-print-patched
openai-compatibility:
  - name: compatible
    base-url: https://example.invalid
    api-key-entries: [{api-key: never-print-upstream}]
`, filepath.ToSlash(auth))
	if err := os.WriteFile(path, []byte(source), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if status := Main(context.Background(), []string{"-check-config", "-config", path}, &out, &out); status != 0 {
		t.Fatalf("status %d, output %s", status, out.String())
	}
	if !ojson.Get(out.String(), "ok").Bool() || ojson.Get(out.String(), "settings.port").Int() != 8317 {
		t.Fatal(out.String())
	}
	if !strings.Contains(out.String(), "patched-build-setting") {
		t.Fatal("unknown key was not reported")
	}
	for _, secret := range []string{"never-print-management", "never-print-access", "never-print-patched", "never-print-upstream"} {
		if strings.Contains(out.String(), secret) {
			t.Fatal("secret appeared in output")
		}
	}
	saved, err := os.ReadFile(path)
	if err != nil || string(saved) != source {
		t.Fatal("source config changed")
	}
	if _, errStat := os.Stat(auth); !os.IsNotExist(errStat) {
		t.Fatal("auth directory was opened for writing")
	}
}

func TestConfigCheckRedactsIncompatibleValues(t *testing.T) {
	for _, source := range []string{
		"server: {port: never-print-this-value}\n",
		"config-version: 99\n",
		"server: {port: 8317, port: 9999}\n",
		"management: {secret-key: [never-print-this-value]}\n",
	} {
		t.Run(source[:6], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.yaml")
			if err := os.WriteFile(path, []byte(source), 0600); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			if Main(context.Background(), []string{"-check-config", "-config", path}, &out, &out) != 1 {
				t.Fatal("invalid config accepted")
			}
			if strings.Contains(out.String(), "never-print-this-value") {
				t.Fatal("value leaked")
			}
			if !ojson.Valid(out.String()) {
				t.Fatal(out.String())
			}
		})
	}
}

func TestProbeUsesKeysAndCountsOnlyFileAccounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/healthz":
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case "/v1/models":
			if r.Header.Get("Authorization") != "Bearer access-secret" {
				t.Error("access credential missing")
			}
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/v0/management/auth-files":
			if r.Header.Get("Authorization") != "Bearer management-secret" {
				t.Error("management credential missing")
			}
			_, _ = w.Write([]byte(`{"files":[{"name":"one.json","source":"file"},{"name":"two.json"},{"runtime_only":true},{"source":"memory"}]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	// one.json is in the auth directory; two.json belongs to some other directory.
	authDir := t.TempDir()
	if errWrite := os.WriteFile(filepath.Join(authDir, "one.json"), []byte(`{"type":"codex"}`), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	result := probeHub(context.Background(), server.URL, "access-secret", "management-secret", authDir, server.Client())
	if !result.Health || !result.Models || result.Accounts != 2 || result.AccountsOutsideAuthDir != 1 || result.InFlight != -1 {
		t.Fatalf("unexpected result %+v", result)
	}
	if !accountInAuthDir(authDir, filepath.Join(authDir, "x.json"), "") || accountInAuthDir(authDir, filepath.Join(t.TempDir(), "one.json"), "one.json") {
		t.Fatal("a reported path must decide whether the account is in the auth directory")
	}
}

func TestProbeDoesNotFollowCredentialRedirect(t *testing.T) {
	reached := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer source.Close()
	result := probeHub(context.Background(), source.URL, "access", "management", t.TempDir(), source.Client())
	if reached || result.Models || result.Accounts != -1 {
		t.Fatal("credential redirect followed")
	}
}

func TestConfigCheckProbeReadsPlaintextAndHashedManagementKeys(t *testing.T) {
	t.Setenv("MANAGEMENT_PASSWORD", "")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		expectedKey := "management-secret"
		if r.URL.Path == "/v1/models" {
			expectedKey = "access-secret"
		}
		if r.Header.Get("Authorization") != "Bearer "+expectedKey {
			t.Error("wrong key used")
		}
		switch r.URL.Path {
		case "/v1/models":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/v0/management/auth-files":
			_, _ = w.Write([]byte(`{"files":[]}`))
		case "/v8/management/observability/requests/in-flight":
			_, _ = w.Write([]byte(`{"in_flight":0}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	for _, hashed := range []bool{false, true} {
		dir := t.TempDir()
		path := filepath.Join(dir, "config.yaml")
		key := "management-secret"
		args := []string{"-check-config", "-config", path, "-probe-url", server.URL}
		if hashed {
			key = "$2a$already-hashed-secret"
			keyPath := filepath.Join(dir, "management.key")
			if errWrite := os.WriteFile(keyPath, []byte("management-secret"), 0600); errWrite != nil {
				t.Fatal(errWrite)
			}
			args = append(args, "-management-key-file", keyPath)
		}
		source := "server: {port: 8317}\naccess: {api-keys: [access-secret]}\nmanagement: {secret-key: '" + key + "'}\n"
		if errWrite := os.WriteFile(path, []byte(source), 0600); errWrite != nil {
			t.Fatal(errWrite)
		}
		var out bytes.Buffer
		if code := Main(context.Background(), args, &out, &out); code != 0 {
			t.Fatal(out.String())
		}
		if ojson.Get(out.String(), "probe.in_flight").Int() != 0 || !ojson.Get(out.String(), "probe.models").Bool() {
			t.Fatal(out.String())
		}
		if strings.Contains(out.String(), "management-secret") || strings.Contains(out.String(), "access-secret") {
			t.Fatal("probe leaked a secret")
		}
	}
}

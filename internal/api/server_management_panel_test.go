package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/managementasset"
)

func TestManagementControlPanelServesBuiltInPanelWithoutRepository(t *testing.T) {
	t.Setenv("MANAGEMENT_STATIC_PATH", t.TempDir())
	server := newTestServer(t)
	server.cfg.RemoteManagement.PanelGitHubRepository = ""

	req := httptest.NewRequest(http.MethodGet, "/management.html", nil)
	rr := httptest.NewRecorder()
	server.engine.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d body=%s", rr.Code, http.StatusOK, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("Content-Type = %q, want text/html", ct)
	}
	want := managementasset.PlaceholderHTML()
	if embedded, ok := managementasset.EmbeddedHTML(); ok {
		want = embedded
	}
	if rr.Body.String() != string(want) {
		t.Fatalf("body does not match the built-in panel (len=%d)", rr.Body.Len())
	}
}

func TestManagementControlPanelServesStaticPathOverride(t *testing.T) {
	staticDir := t.TempDir()
	t.Setenv("MANAGEMENT_STATIC_PATH", staticDir)
	if errWrite := os.WriteFile(filepath.Join(staticDir, "management.html"), []byte("<html>override panel</html>"), 0o600); errWrite != nil {
		t.Fatalf("write override: %v", errWrite)
	}
	server := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/management.html", nil)
	rr := httptest.NewRecorder()
	server.engine.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "override panel") {
		t.Fatalf("status = %d body=%s, want override panel", rr.Code, rr.Body.String())
	}
}

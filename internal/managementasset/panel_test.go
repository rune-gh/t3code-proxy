package managementasset

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/config"
)

func setEmbeddedPanelForTest(t *testing.T, data []byte) {
	t.Helper()
	prev := embeddedPanelOverride
	embeddedPanelOverride = data
	t.Cleanup(func() { embeddedPanelOverride = prev })
}

func writeConfigFile(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if errWrite := os.WriteFile(path, []byte("port: 0\n"), 0o600); errWrite != nil {
		t.Fatalf("write config: %v", errWrite)
	}
	return path
}

func isolateStaticDir(t *testing.T) {
	t.Helper()
	t.Setenv("MANAGEMENT_STATIC_PATH", "")
	t.Setenv("WRITABLE_PATH", "")
	t.Setenv("writable_path", "")
}

func TestExplicitPanelRepository(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{in: "", want: ""},
		{in: "   ", want: ""},
		{in: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center", want: ""},
		{in: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center/", want: ""},
		{in: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center.git", want: ""},
		{in: "https://api.github.com/repos/router-for-me/Cli-Proxy-API-Management-Center/releases/latest", want: ""},
		{in: " https://github.com/example/panel ", want: "https://github.com/example/panel"},
	}
	for _, tt := range tests {
		if got := ExplicitPanelRepository(tt.in); got != tt.want {
			t.Errorf("ExplicitPanelRepository(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestResolveReleaseURLRejectsNonGitHub(t *testing.T) {
	for _, in := range []string{"", "not a url", "https://example.com/org/repo", "https://github.com/onlyorg"} {
		if got := resolveReleaseURL(in); got != "" {
			t.Errorf("resolveReleaseURL(%q) = %q, want empty", in, got)
		}
	}
	if got, want := resolveReleaseURL("https://github.com/rune-gh/t3code-proxy.git"), "https://api.github.com/repos/rune-gh/t3code-proxy/releases/latest"; got != want {
		t.Errorf("resolveReleaseURL() = %q, want %q", got, want)
	}
}

func TestResolvePanelServesEmbeddedWithoutRepository(t *testing.T) {
	isolateStaticDir(t)
	setEmbeddedPanelForTest(t, []byte("<html>embedded panel</html>"))
	configPath := writeConfigFile(t)
	// A stale panel downloaded by an older release must not shadow the embedded panel.
	staticDir := StaticDir(configPath)
	if errMkdir := os.MkdirAll(staticDir, 0o755); errMkdir != nil {
		t.Fatal(errMkdir)
	}
	if errWrite := os.WriteFile(filepath.Join(staticDir, ManagementFileName), []byte("stale"), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}

	for _, repo := range []string{"", "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"} {
		cfg := &config.Config{}
		cfg.RemoteManagement.PanelGitHubRepository = repo
		panel := ResolvePanel(t.Context(), configPath, cfg)
		if panel.FilePath != "" || !panel.Embedded || string(panel.HTML) != "<html>embedded panel</html>" {
			t.Fatalf("repo=%q: ResolvePanel() = %+v, want embedded panel", repo, panel)
		}
	}
}

func TestResolvePanelServesPlaceholderWhenNothingEmbedded(t *testing.T) {
	isolateStaticDir(t)
	setEmbeddedPanelForTest(t, []byte{})
	panel := ResolvePanel(t.Context(), writeConfigFile(t), &config.Config{})
	if panel.FilePath != "" || panel.Embedded {
		t.Fatalf("ResolvePanel() = %+v, want placeholder", panel)
	}
	if !bytes.Equal(panel.HTML, PlaceholderHTML()) || !strings.Contains(string(panel.HTML), "make web") {
		t.Fatalf("placeholder HTML missing build instructions: %s", panel.HTML)
	}
}

func TestResolvePanelPrefersStaticPathOverride(t *testing.T) {
	isolateStaticDir(t)
	setEmbeddedPanelForTest(t, []byte("<html>embedded panel</html>"))
	overrideDir := t.TempDir()
	t.Setenv("MANAGEMENT_STATIC_PATH", overrideDir)
	overrideFile := filepath.Join(overrideDir, ManagementFileName)

	// Missing override file falls through to the embedded panel.
	if panel := ResolvePanel(t.Context(), writeConfigFile(t), &config.Config{}); !panel.Embedded {
		t.Fatalf("ResolvePanel() without override file = %+v, want embedded", panel)
	}

	if errWrite := os.WriteFile(overrideFile, []byte("<html>override</html>"), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	panel := ResolvePanel(t.Context(), writeConfigFile(t), &config.Config{})
	if panel.FilePath != overrideFile {
		t.Fatalf("ResolvePanel() = %+v, want override file %s", panel, overrideFile)
	}
}

func TestResolvePanelUsesDownloadedAssetForExplicitRepository(t *testing.T) {
	isolateStaticDir(t)
	setEmbeddedPanelForTest(t, []byte("<html>embedded panel</html>"))
	configPath := writeConfigFile(t)
	staticDir := StaticDir(configPath)
	if errMkdir := os.MkdirAll(staticDir, 0o755); errMkdir != nil {
		t.Fatal(errMkdir)
	}
	downloaded := filepath.Join(staticDir, ManagementFileName)
	if errWrite := os.WriteFile(downloaded, []byte("<html>custom</html>"), 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	cfg := &config.Config{}
	cfg.RemoteManagement.PanelGitHubRepository = "https://github.com/example/panel"
	panel := ResolvePanel(t.Context(), configPath, cfg)
	if panel.FilePath != downloaded {
		t.Fatalf("ResolvePanel() = %+v, want downloaded asset %s", panel, downloaded)
	}
}

func TestEnsureLatestManagementHTMLWithoutRepositoryMakesNoChanges(t *testing.T) {
	staticDir := filepath.Join(t.TempDir(), "static")
	if EnsureLatestManagementHTML(t.Context(), staticDir, "", "") {
		t.Fatal("EnsureLatestManagementHTML() = true, want false without asset")
	}
	if _, errStat := os.Stat(staticDir); !os.IsNotExist(errStat) {
		t.Fatalf("static dir was created without a configured repository: %v", errStat)
	}
}

func TestEmbeddedPanelFSHasDirectory(t *testing.T) {
	// The embed directory must exist (it is kept with .gitkeep) for the binary to build.
	if _, errRead := embeddedPanelFS.ReadDir("embedded"); errRead != nil {
		t.Fatalf("embedded directory missing: %v", errRead)
	}
}

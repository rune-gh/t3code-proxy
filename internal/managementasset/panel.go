package managementasset

import (
	"context"
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/rune-oai/t3code-proxy/internal/config"
)

// embeddedPanelFS holds the management panel compiled into the binary. The build
// copies web/dist/index.html to embedded/management.html; the directory only
// contains .gitkeep in a plain checkout, in which case PlaceholderHTML is served.
//
//go:embed all:embedded
var embeddedPanelFS embed.FS

const embeddedPanelPath = "embedded/" + managementAssetName

// legacyPanelReleaseURL is the release endpoint of the panel repository that older
// configuration templates set explicitly. Such configs did not make a deliberate
// choice, so this value is treated like an unset repository.
const legacyPanelReleaseURL = "https://api.github.com/repos/router-for-me/cli-proxy-api-management-center/releases/latest"

// placeholderHTML is served when the binary was built without the panel.
const placeholderHTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>t3code-proxy management panel not built</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
code { background: #f2f2f2; padding: 0.1rem 0.3rem; border-radius: 3px; }
</style>
</head>
<body>
<h1>Management panel not built</h1>
<p>This t3code-proxy binary was built without the web management panel.
The proxy API and the management API under <code>/v0/management</code> work normally.</p>
<p>To include the panel, build it from the repository root and rebuild the binary:</p>
<pre><code>make web
go build -o t3code-proxy ./cmd/server</code></pre>
<p><code>make web</code> builds <code>web/</code> and copies <code>web/dist/index.html</code> to
<code>internal/managementasset/embedded/management.html</code>, which is compiled into the binary.</p>
</body>
</html>
`

var embeddedPanelOverride []byte // tests only

// EmbeddedHTML returns the management panel compiled into the binary, if any.
func EmbeddedHTML() ([]byte, bool) {
	if embeddedPanelOverride != nil {
		return embeddedPanelOverride, len(embeddedPanelOverride) > 0
	}
	data, errRead := fs.ReadFile(embeddedPanelFS, embeddedPanelPath)
	if errRead != nil || len(data) == 0 {
		return nil, false
	}
	return data, true
}

// PlaceholderHTML returns the page served when no panel is embedded.
func PlaceholderHTML() []byte {
	return []byte(placeholderHTML)
}

// ExplicitPanelRepository returns the trimmed panel repository when the user chose
// one, or "" when it is unset or equals the legacy template default.
func ExplicitPanelRepository(repo string) string {
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return ""
	}
	if strings.EqualFold(resolveReleaseURL(repo), legacyPanelReleaseURL) {
		return ""
	}
	return repo
}

// Panel describes how to serve the management control panel.
type Panel struct {
	// FilePath is a panel file on disk to serve. When empty, HTML is served instead.
	FilePath string
	// HTML is the in-memory panel page (embedded panel or placeholder).
	HTML []byte
	// Embedded reports whether HTML is the panel compiled into the binary.
	Embedded bool
}

// ResolvePanel decides which management panel to serve, in order:
//  1. an existing file at MANAGEMENT_STATIC_PATH (explicit on-disk override);
//  2. with an explicit panel-github-repository, the downloaded release asset
//     (downloaded synchronously when missing);
//  3. the panel embedded in the binary;
//  4. a placeholder page explaining how to build the panel.
//
// Only step 2 performs network calls.
func ResolvePanel(ctx context.Context, configFilePath string, cfg *config.Config) Panel {
	if override := strings.TrimSpace(os.Getenv("MANAGEMENT_STATIC_PATH")); override != "" {
		if path := FilePath(configFilePath); path != "" && regularFileExists(path) {
			return Panel{FilePath: path}
		}
	}

	if cfg != nil {
		if repo := ExplicitPanelRepository(cfg.RemoteManagement.PanelGitHubRepository); repo != "" {
			if path := FilePath(configFilePath); path != "" {
				if regularFileExists(path) || EnsureLatestManagementHTML(ctx, filepath.Dir(path), cfg.ProxyURL, repo) {
					return Panel{FilePath: path}
				}
			}
		}
	}

	if data, ok := EmbeddedHTML(); ok {
		return Panel{HTML: data, Embedded: true}
	}
	return Panel{HTML: PlaceholderHTML()}
}

func regularFileExists(path string) bool {
	info, errStat := os.Stat(path)
	return errStat == nil && info.Mode().IsRegular()
}

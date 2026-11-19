package doctor

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/MoeForge/moego/ojson"
	"gopkg.in/yaml.v3"
)

// hubConfig is the small subset of config.yaml the doctor reports on. It is
// decoded directly with yaml.v3 so the doctor does not depend on the server's
// config package.
type hubConfig struct {
	TraceArchive struct {
		Enabled    bool     `yaml:"enabled"`
		Recipients []string `yaml:"recipients"`
	} `yaml:"trace-archive"`
	Host   string   `yaml:"host"`
	Port   int      `yaml:"port"`
	Keys   []string `yaml:"api-keys"`
	Server struct {
		Host string `yaml:"host"`
		Port int    `yaml:"port"`
	} `yaml:"server"`
	Management struct {
		SecretKey string `yaml:"secret-key"`
	} `yaml:"management"`
	Access struct {
		APIKeys []string `yaml:"api-keys"`
	} `yaml:"access"`
	Routing struct {
		Strategy        string `yaml:"strategy"`
		SessionAffinity bool   `yaml:"session-affinity"`
	} `yaml:"routing"`
	OAuth struct {
		AuthDir string `yaml:"auth-dir"`
	} `yaml:"oauth"`
	AuthDir string `yaml:"auth-dir"`
}

// placeholderValues are template values that must be replaced before use.
var placeholderValues = map[string]bool{
	"replace-me": true, "change-me": true, "your-api-key-1": true,
	"your-api-key-2": true, "your-api-key-3": true,
	"replace-with-a-54-char-url-safe-key": true,
}

var errNoConfig = errors.New("no config file found")

func loadConfig(e *env) (string, *hubConfig, error) {
	candidates := []string{e.ConfigPath}
	if e.ConfigPath == "" {
		candidates = DefaultConfigPaths(e.GOOS, e.HomeDir)
	}
	for _, p := range candidates {
		data, err := e.FS.ReadFile(p)
		if err != nil {
			if isNotExist(err) {
				continue
			}
			return p, nil, err
		}
		var cfg hubConfig
		if errParse := yaml.Unmarshal(data, &cfg); errParse != nil {
			return p, nil, errParse
		}
		// Older flat layouts set host/port/api-keys/auth-dir at the top level.
		if cfg.Server.Host == "" {
			cfg.Server.Host = cfg.Host
		}
		if cfg.Server.Port == 0 {
			cfg.Server.Port = cfg.Port
		}
		if len(cfg.Access.APIKeys) == 0 {
			cfg.Access.APIKeys = cfg.Keys
		}
		if cfg.OAuth.AuthDir == "" {
			cfg.OAuth.AuthDir = cfg.AuthDir
		}
		return p, &cfg, nil
	}
	return strings.Join(candidates, ", "), nil, errNoConfig
}

func checkConfig(e *env) Result {
	r := Result{Name: "config"}
	if e.cfgErr != nil {
		r.Status = StatusFail
		if errors.Is(e.cfgErr, errNoConfig) {
			r.Detail = "no config at " + e.cfgPath
			r.Hint = "copy config.hub.example.yaml to config.yaml, or run the installer"
		} else {
			r.Detail = "cannot read " + e.cfgPath + ": " + e.cfgErr.Error()
			r.Hint = "fix the YAML syntax"
		}
		return r
	}
	c := e.cfg
	host := c.Server.Host
	var problems, warnings []string
	if c.TraceArchive.Enabled && len(c.TraceArchive.Recipients) == 0 {
		problems = append(problems, "trace archive requires an age X25519 recipient")
	}
	switch host {
	case "127.0.0.1", "localhost", "::1":
	case "":
		warnings = append(warnings, "binds all interfaces")
	default:
		warnings = append(warnings, "binds "+host)
	}
	secret := strings.TrimSpace(c.Management.SecretKey)
	switch {
	case secret == "":
		warnings = append(warnings, "no management secret (panel disabled)")
	case placeholderValues[secret]:
		problems = append(problems, "management secret is a placeholder")
	}
	keys := 0
	for _, k := range c.Access.APIKeys {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		if placeholderValues[k] {
			problems = append(problems, "an API key is a placeholder")
			continue
		}
		keys++
	}
	if keys == 0 {
		problems = append(problems, "no access API key")
	}
	strategy := firstNonEmpty(c.Routing.Strategy, "round-robin")
	if strategy != "soonest-reset-first" {
		warnings = append(warnings, "routing "+strategy)
	}
	if !c.Routing.SessionAffinity {
		warnings = append(warnings, "session affinity off")
	}

	r.Detail = e.cfgPath + ": host " + firstNonEmpty(host, `""`) +
		", secret " + setWord(secret != "") +
		", " + strconv.Itoa(keys) + " API key(s)" +
		", routing " + strategy +
		", affinity " + onWord(c.Routing.SessionAffinity)
	switch {
	case len(problems) > 0:
		r.Status = StatusFail
		r.Hint = strings.Join(problems, "; ")
	case len(warnings) > 0:
		r.Status = StatusWarn
		r.Hint = strings.Join(warnings, "; ") + "; see config.hub.example.yaml"
	default:
		r.Status = StatusOK
	}
	return r
}

// resolveAuthDir returns the auth directory from flags, config, or the default.
func resolveAuthDir(e *env) string {
	dir := e.AuthDir
	if dir == "" && e.cfg != nil {
		dir = e.cfg.OAuth.AuthDir
	}
	if dir == "" {
		// Mirror the server default: new installs use ~/.t3code-proxy, and an
		// existing ~/.cli-proxy-api keeps being used when the new one is absent.
		dir = "~/.t3code-proxy"
		if _, errNew := os.Stat(filepath.Join(e.HomeDir, ".t3code-proxy")); errNew != nil {
			if _, errLegacy := os.Stat(filepath.Join(e.HomeDir, ".cli-proxy-api")); errLegacy == nil {
				dir = "~/.cli-proxy-api"
			}
		}
	}
	if dir == "~" || strings.HasPrefix(dir, "~/") || strings.HasPrefix(dir, `~\`) {
		dir = filepath.Join(e.HomeDir, dir[1:])
	}
	if !filepath.IsAbs(dir) && e.cfgErr == nil && e.cfg != nil {
		dir = filepath.Join(filepath.Dir(e.cfgPath), dir)
	}
	return dir
}

func checkAuthDir(e *env) Result {
	r := Result{Name: "accounts"}
	dir := resolveAuthDir(e)
	entries, err := e.FS.ReadDir(dir)
	if err != nil {
		r.Status = StatusWarn
		r.Detail = "auth dir " + dir + " is missing"
		r.Hint = "sign in with: t3code-proxy -claude-login -no-browser (or -codex-device-login)"
		return r
	}
	counts := map[string]int{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		data, errRead := e.FS.ReadFile(filepath.Join(dir, entry.Name()))
		if errRead != nil || !ojson.ValidBytes(data) {
			continue
		}
		provider := strings.ToLower(ojson.GetBytes(data, "type").String())
		if provider == "" {
			continue
		}
		counts[provider]++
	}
	if len(counts) == 0 {
		r.Status = StatusWarn
		r.Detail = "no accounts in " + dir
		r.Hint = "sign in with: t3code-proxy -claude-login -no-browser (or -codex-device-login)"
		return r
	}
	names := make([]string, 0, len(counts))
	for name := range counts {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, name+" "+strconv.Itoa(counts[name]))
	}
	r.Detail = strings.Join(parts, ", ") + " in " + dir
	if counts["claude"]+counts["codex"] == 0 {
		r.Status = StatusWarn
		r.Hint = "no Claude or Codex account; sign in with -claude-login or -codex-login"
		return r
	}
	r.Status = StatusOK
	return r
}

func setWord(b bool) string {
	if b {
		return "set"
	}
	return "not set"
}

func onWord(b bool) string {
	if b {
		return "on"
	}
	return "off"
}

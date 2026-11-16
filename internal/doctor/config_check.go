package doctor

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/MoeForge/moego/ojson"
	"github.com/joho/godotenv"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/util"
	log "github.com/sirupsen/logrus"
	"gopkg.in/yaml.v3"
)

// Config checking uses the production loader on a disposable copy because that
// loader hashes management secrets and cleans conflicting fields on disk.
// No credential store, server, watcher, or catalog updater is constructed.
func checkConfigCommand(ctx context.Context, path, probeURL, keyFile string, out io.Writer) bool {
	doc := ojson.NewDocString(`{"ok":false,"issues":[],"unknown_keys":[],"probe":null}`)
	fail := func(reason string) bool {
		_ = doc.Set("reason", reason)
		_, _ = fmt.Fprintln(out, doc.String())
		return false
	}
	if path == "" {
		path = "config.yaml"
	}
	data, errRead := os.ReadFile(path)
	if errRead != nil {
		return fail("cannot read config file")
	}
	// Suppress production sanitizer logs, which can include user-controlled values.
	previousOutput := log.StandardLogger().Out
	log.SetOutput(io.Discard)
	defer log.SetOutput(previousOutput)
	env, errEnv := godotenv.Read(".env")
	if errEnv != nil && !os.IsNotExist(errEnv) {
		return fail("cannot parse working-directory .env")
	}
	lookup := func(key string) string {
		if value, exists := os.LookupEnv(key); exists {
			return value
		}
		return env[key]
	}
	for _, key := range []string{"HOME_JWT", "home_jwt", "PGSTORE_DSN", "pgstore_dsn", "GITSTORE_GIT_URL", "gitstore_git_url", "OBJECTSTORE_ENDPOINT", "objectstore_endpoint"} {
		if strings.TrimSpace(lookup(key)) != "" {
			return fail("config check requires local file storage without Home or cloud deployment")
		}
	}
	if lookup("DEPLOY") == "cloud" {
		return fail("config check requires local file storage without Home or cloud deployment")
	}
	var raw config.Config
	if errParse := yaml.Unmarshal(data, &raw); errParse != nil {
		_ = doc.Set("issues", configDiagnostics(errParse))
		return fail("incompatible config or invalid YAML (values redacted)")
	}
	tmp, errTemp := os.MkdirTemp("", "t3code-config-check-")
	if errTemp != nil {
		return fail("cannot create private temporary config copy")
	}
	defer func() {
		if errRemove := os.RemoveAll(tmp); errRemove != nil {
			log.Warn("could not remove temporary config check directory")
		}
	}()
	copyPath := filepath.Join(tmp, "config.yaml")
	if errWrite := os.WriteFile(copyPath, data, 0600); errWrite != nil {
		return fail("cannot write private temporary config copy")
	}
	cfg, errLoad := config.LoadConfig(copyPath)
	if errRemove := os.RemoveAll(tmp); errRemove != nil {
		return fail("cannot remove private temporary config copy")
	}
	if errLoad != nil {
		_ = doc.Set("issues", configDiagnostics(errLoad))
		return fail("server config loader rejected config (values redacted)")
	}
	unknown := []string{}
	config.SetV8MigrationWarnFunc(func(section, _ string) { unknown = append(unknown, section) })
	normalized, _, errNormalize := config.NormalizeConfigLayout(data, true)
	config.SetV8MigrationWarnFunc(nil)
	_ = doc.Set("unknown_keys", unknown)
	if errNormalize != nil {
		return fail("cannot inspect config layout (values redacted)")
	}
	// Strict validation also examines fields inside provider/key sequences.
	if errStrict := config.ValidateV8Config(normalized); errStrict != nil {
		_ = doc.Set("issues", configDiagnostics(errStrict))
	}
	authDir, errAuth := util.ResolveAuthDir(cfg.AuthDir)
	if errAuth != nil {
		return fail("cannot resolve auth directory")
	}
	authDir, errAuth = filepath.Abs(authDir)
	if errAuth != nil {
		return fail("cannot resolve auth directory")
	}
	_ = doc.Set("settings.port", cfg.Port)
	_ = doc.Set("settings.host", cfg.Host)
	_ = doc.Set("settings.tls", cfg.TLS.Enable)
	_ = doc.Set("settings.auth_dir", authDir)
	_ = doc.Set("settings.access_key_count", len(cfg.APIKeys))
	_ = doc.Set("settings.config_sha256", config.ComputeSourceHash(data))
	paths := []string{authDir}
	for _, source := range []string{cfg.Models.Catalog, cfg.Models.CodexCatalog, cfg.Models.DevinCatalog, cfg.TLS.Cert, cfg.TLS.Key} {
		if source == "" {
			continue
		}
		parsed, errURL := url.Parse(source)
		if errURL == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
			continue
		}
		paths = append(paths, source)
	}
	if cfg.Plugins.Enabled {
		paths = append(paths, cfg.Plugins.Dir)
	}
	_ = doc.Set("settings.required_paths", paths)
	if probeURL != "" {
		parsed, errURL := url.Parse(probeURL)
		if errURL != nil || parsed.Scheme != "http" || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1") || parsed.User != nil {
			return fail("probe URL must be loopback HTTP")
		}
		secret := raw.RemoteManagement.SecretKey
		if keyFile != "" {
			key, errKey := os.ReadFile(keyFile)
			if errKey != nil {
				return fail("cannot read management key file")
			}
			secret = strings.TrimSpace(string(key))
		} else if value := lookup("MANAGEMENT_PASSWORD"); value != "" {
			secret = value
		}
		if secret == "" || strings.HasPrefix(secret, "$2") {
			return fail("management plaintext unavailable; supply -management-key-file")
		}
		if len(cfg.APIKeys) == 0 {
			return fail("config has no access API key")
		}
		probe := probeHub(ctx, strings.TrimRight(probeURL, "/"), cfg.APIKeys[0], secret, authDir, http.DefaultClient)
		_ = doc.Set("probe", probe)
		if !probe.Models || probe.Accounts < 0 {
			return fail("authenticated hub probe failed")
		}
	}
	_ = doc.Set("ok", true)
	_, _ = fmt.Fprintln(out, doc.String())
	return true
}

var configDiagnosticPattern = regexp.MustCompile(`(?m)line [0-9]+|field [a-zA-Z][a-zA-Z0-9_-]* not found|(?:server|models|routing|oauth|access|management|credentials|api-keys)[.a-zA-Z0-9_-]* must be [a-zA-Z ()-]+|unsupported config-version`)

func configDiagnostics(err error) []string {
	diagnostics := configDiagnosticPattern.FindAllString(err.Error(), -1)
	if len(diagnostics) == 0 {
		return []string{"unknown or incompatible setting; values redacted"}
	}
	return diagnostics
}

type hubProbe struct {
	Health   bool `json:"health"`
	Models   bool `json:"models"`
	Accounts int  `json:"accounts"`
	// AccountsOutsideAuthDir counts file accounts the hub serves that are not
	// files in the auth directory this config resolves to. A hub reading another
	// directory can hold the same number of accounts with different logins.
	AccountsOutsideAuthDir int   `json:"accounts_outside_auth_dir"`
	InFlight               int64 `json:"in_flight"`
}

// accountInAuthDir reports whether a file account listed by the hub is a file
// directly inside authDir, by its reported path when present, else by name.
func accountInAuthDir(authDir, path, name string) bool {
	if path != "" {
		return strings.EqualFold(filepath.Clean(filepath.Dir(path)), filepath.Clean(authDir))
	}
	if name == "" || name != filepath.Base(name) {
		return false
	}
	info, errStat := os.Stat(filepath.Join(authDir, name))
	return errStat == nil && info.Mode().IsRegular()
}

func probeHub(ctx context.Context, base, accessKey, managementKey, authDir string, client *http.Client) hubProbe {
	result := hubProbe{Accounts: -1, InFlight: -1}
	// Never follow redirects carrying credentials, or inherit an HTTP proxy for localhost.
	localClient := *client
	localClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if client.Transport == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		localClient.Transport = transport
		defer transport.CloseIdleConnections()
	}
	get := func(path, key string) ([]byte, bool) {
		req, errRequest := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
		if errRequest != nil {
			return nil, false
		}
		if key != "" {
			req.Header.Set("Authorization", "Bearer "+key)
		}
		resp, errResponse := localClient.Do(req)
		if errResponse != nil {
			return nil, false
		}
		body, errBody := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		errClose := resp.Body.Close()
		return body, errBody == nil && errClose == nil && resp.StatusCode == http.StatusOK
	}
	health, healthOK := get("/healthz", "")
	result.Health = healthOK && ojson.GetBytes(health, "status").String() == "ok"
	body, ok := get("/v1/models", accessKey)
	result.Models = ok && ojson.ValidBytes(body) && ojson.GetBytes(body, "data").IsArray()
	body, ok = get("/v0/management/auth-files", managementKey)
	if ok && ojson.ValidBytes(body) && ojson.GetBytes(body, "files").IsArray() {
		result.Accounts = 0
		for _, entry := range ojson.GetBytes(body, "files").Array() {
			// Configured API-key providers create virtual auths without a disk file.
			if entry.Get("runtime_only").Bool() || entry.Get("source").String() == "memory" {
				continue
			}
			result.Accounts++
			if !accountInAuthDir(authDir, entry.Get("path").String(), entry.Get("name").String()) {
				result.AccountsOutsideAuthDir++
			}
		}
	}
	body, ok = get("/v8/management/observability/requests/in-flight", managementKey)
	if ok && ojson.ValidBytes(body) && ojson.GetBytes(body, "in_flight").Type == ojson.Number {
		if count, errCount := strconv.ParseInt(ojson.GetBytes(body, "in_flight").Raw, 10, 64); errCount == nil && count >= 0 {
			result.InFlight = count
		}
	}
	return result
}

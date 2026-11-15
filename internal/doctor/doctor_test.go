package doctor

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/MoeForge/moego/ojson"
)

type fakeRunner struct {
	paths   map[string]string
	outputs map[string]string
	errs    map[string]error
}

func (f *fakeRunner) LookPath(name string) (string, error) {
	if p, ok := f.paths[name]; ok {
		return p, nil
	}
	return "", errors.New("not found")
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	key := strings.Join(append([]string{name}, args...), " ")
	if err, ok := f.errs[key]; ok {
		return []byte(f.outputs[key]), err
	}
	if out, ok := f.outputs[key]; ok {
		return []byte(out), nil
	}
	return nil, errors.New("unexpected command: " + key)
}

type fakeHTTP struct {
	status map[string]int
	body   map[string]string
}

func (f fakeHTTP) Get(_ context.Context, url string) (int, []byte, error) {
	s, ok := f.status[url]
	if !ok {
		return 0, nil, errors.New("offline")
	}
	return s, []byte(f.body[url]), nil
}

type fakePorts struct{ free bool }

func (f fakePorts) CanListen(string) bool { return f.free }

type fixedClock struct{}

func (fixedClock) Now() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) }

// mapFS adapts fstest.MapFS (slash paths without a leading slash) to FileSystem.
type mapFS struct{ m fstest.MapFS }

func clean(name string) string { return strings.TrimPrefix(filepath.ToSlash(name), "/") }

func (f mapFS) ReadFile(name string) ([]byte, error)       { return f.m.ReadFile(clean(name)) }
func (f mapFS) ReadDir(name string) ([]os.DirEntry, error) { return f.m.ReadDir(clean(name)) }
func (f mapFS) Stat(name string) (os.FileInfo, error)      { return f.m.Stat(clean(name)) }

const goodConfig = `
server:
  host: "127.0.0.1"
  port: 8317
management:
  secret-key: "s3cret-value-never-printed"
access:
  api-keys: ["key-never-printed"]
routing:
  strategy: soonest-reset-first
  session-affinity: true
oauth:
  auth-dir: "~/auths"
`

func baseOptions() Options {
	files := fstest.MapFS{
		"home/cfg/config.yaml":          {Data: []byte(goodConfig)},
		"home/auths/claude-a.json":      {Data: []byte(`{"type":"claude","email":"a"}`)},
		"home/auths/claude-b.json":      {Data: []byte(`{"type":"claude"}`)},
		"home/auths/codex-a.json":       {Data: []byte(`{"type":"codex"}`)},
		"home/auths/notes.txt":          {Data: []byte("x")},
		"var/lib/systemd/linger/daniel": {Data: nil},
	}
	return Options{
		ConfigPath: "/home/cfg/config.yaml",
		GOOS:       "linux",
		GOARCH:     "amd64",
		HomeDir:    "/home",
		Username:   "daniel",
		Runner: &fakeRunner{
			paths: map[string]string{"systemctl": "/bin/systemctl", "tailscale": "/bin/tailscale", "loginctl": "/bin/loginctl"},
			outputs: map[string]string{
				"systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target": "masked\nmasked\nmasked\nmasked\n",
				"/bin/tailscale status --json":                    `{"BackendState":"Running","Self":{"DNSName":"hub.tail1234.ts.net."}}`,
				"/bin/tailscale serve status --json":              `{"TCP":{"8317":{"HTTPS":true}},"Web":{"hub.tail1234.ts.net:8317":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8317"}}}}}`,
				"systemctl --user is-active t3code-proxy.service": "active\n",
				"loginctl show-user daniel --property=Linger":     "Linger=yes\n",
			},
		},
		HTTP:  fakeHTTP{status: map[string]int{ipinfoOrgURL: 200}, body: map[string]string{ipinfoOrgURL: "AS7922 Comcast Cable Communications, LLC\n"}},
		Ports: fakePorts{free: true},
		Clock: fixedClock{},
		FS:    mapFS{m: files},
	}
}

func resultByName(t *testing.T, opts Options, name string) Result {
	t.Helper()
	for _, r := range runChecks(context.Background(), newEnv(opts)) {
		if r.Name == name {
			return r
		}
	}
	t.Fatalf("no check named %q", name)
	return Result{}
}

func TestRunAllOK(t *testing.T) {
	var buf bytes.Buffer
	if !Run(context.Background(), &buf, baseOptions()) {
		t.Fatalf("expected ok, got:\n%s", buf.String())
	}
	out := buf.String()
	for _, want := range []string{"ok    os", "Comcast", "claude 2, codex 1", "hub.tail1234.ts.net"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "never-printed") {
		t.Fatalf("secret leaked into output:\n%s", out)
	}
	if strings.Contains(out, "warn") || strings.Contains(out, "fail ") {
		t.Errorf("unexpected warn/fail:\n%s", out)
	}
}

func TestJSONOutput(t *testing.T) {
	opts := baseOptions()
	opts.JSON = true
	var buf bytes.Buffer
	Run(context.Background(), &buf, opts)
	if !ojson.ValidBytes(buf.Bytes()) {
		t.Fatalf("invalid JSON: %s", buf.String())
	}
	if !ojson.GetBytes(buf.Bytes(), "ok").Bool() {
		t.Errorf("expected ok=true: %s", buf.String())
	}
	if got := ojson.GetBytes(buf.Bytes(), "checks.#").Int(); got != 10 {
		t.Errorf("checks count = %d, want 10", got)
	}
	if got := ojson.GetBytes(buf.Bytes(), "checks.0.name").String(); got != "os" {
		t.Errorf("first check = %q", got)
	}
	if got := ojson.GetBytes(buf.Bytes(), "time").String(); got != "2026-01-02T03:04:05Z" {
		t.Errorf("time = %q", got)
	}
	if strings.Contains(buf.String(), "never-printed") {
		t.Fatal("secret leaked into JSON")
	}
}

func TestIsDatacenterOrg(t *testing.T) {
	cases := map[string]bool{
		"AS16509 Amazon.com, Inc.":              true,
		"AS15169 Google LLC":                    true,
		"AS8075 Microsoft Corporation":          true,
		"AS24940 Hetzner Online GmbH":           true,
		"AS14061 DigitalOcean, LLC":             true,
		"AS16276 OVH SAS":                       true,
		"AS63949 Akamai Connected Cloud":        true,
		"AS20473 The Constant Company, LLC":     true,
		"AS20473 Choopa, LLC":                   true,
		"AS31898 Oracle Corporation":            true,
		"AS12876 Scaleway S.a.s.":               true,
		"AS51167 Contabo GmbH":                  true,
		"AS7922 Comcast Cable Communications":   false,
		"AS3320 Deutsche Telekom AG":            false,
		"AS16591 Google Fiber Inc.":             false,
		"AS12345 Lawson Broadband":              false,
		"AS2856 British Telecommunications PLC": false,
		"AS9999 Example AWS reseller":           true,
		"AS4134 CHINANET-BACKBONE":              false,
		"AS37963 Hangzhou Alibaba Advertising":  true,
		"AS13335 Cloudflare, Inc.":              true,
		"AS701 Verizon Business":                false,
		"AS20115 Charter Communications":        false,
		"AS6830 Liberty Global B.V.":            false,
		"AS852 TELUS Communications Inc.":       false,
		"AS5089 Virgin Media Limited":           false,
		"AS3215 Orange S.A.":                    false,
		"AS9009 M247 Europe SRL":                true,
		"AS396982 Google Cloud Platform":        true,
		"AS8560 IONOS SE":                       true,
		"AS60781 LeaseWeb Netherlands B.V.":     true,
		"AS53667 FranTech Solutions":            true,
		"AS40021 Contabo Inc.":                  true,
		"AS209 CenturyLink Communications, LLC": false,
		"AS7018 AT&T Services, Inc.":            false,
		"AS22773 Cox Communications Inc.":       false,
		"AS5650 Frontier Communications":        false,
		"AS12322 Free SAS":                      false,
		"AS3352 Telefonica de Espana":           false,
		"AS1136 KPN B.V.":                       false,
		"AS6327 Shaw Communications Inc.":       false,
		"AS812 Rogers Communications Canada":    false,
		"AS4766 Korea Telecom":                  false,
		"AS17676 SoftBank Corp.":                false,
		"AS2516 KDDI CORPORATION":               false,
		"AS45090 Shenzhen Tencent Computer":     true,
		"AS14618 Amazon Data Services":          true,
		"AS20940 Akamai International B.V.":     true,
		"AS8100 QuadraNet Enterprises LLC":      true,
		"AS36352 ColoCrossing":                  true,
		"AS197540 netcup GmbH":                  true,
		"AS62567 DigitalOcean Droplet":          true,
	}
	for org, want := range cases {
		if got := IsDatacenterOrg(org); got != want {
			t.Errorf("IsDatacenterOrg(%q) = %v, want %v", org, got, want)
		}
	}
}

func TestNetworkDatacenterFails(t *testing.T) {
	opts := baseOptions()
	opts.HTTP = fakeHTTP{status: map[string]int{ipinfoOrgURL: 200}, body: map[string]string{ipinfoOrgURL: "AS24940 Hetzner Online GmbH"}}
	r := resultByName(t, opts, "network")
	if r.Status != StatusFail || !strings.Contains(r.Hint, "datacenter") {
		t.Fatalf("got %+v", r)
	}
	var buf bytes.Buffer
	if Run(context.Background(), &buf, opts) {
		t.Fatal("Run should report failure for a datacenter network")
	}
}

func TestNetworkOfflineAndUnreachable(t *testing.T) {
	opts := baseOptions()
	opts.Offline = true
	if r := resultByName(t, opts, "network"); r.Status != StatusSkip {
		t.Fatalf("offline: %+v", r)
	}
	opts = baseOptions()
	opts.HTTP = fakeHTTP{}
	if r := resultByName(t, opts, "network"); r.Status != StatusWarn {
		t.Fatalf("unreachable: %+v", r)
	}
}

func TestSleepPerOS(t *testing.T) {
	opts := baseOptions()
	opts.Runner.(*fakeRunner).outputs["systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target"] = "static\nenabled\nmasked\nmasked\n"
	if r := resultByName(t, opts, "sleep"); r.Status != StatusWarn || !strings.Contains(r.Hint, "mask") {
		t.Fatalf("linux: %+v", r)
	}

	opts = baseOptions()
	opts.GOOS = "darwin"
	opts.Runner = &fakeRunner{outputs: map[string]string{"pmset -g": "System-wide power settings:\nCurrently in use:\n standby              1\n sleep                0 (sleep prevented by powerd)\n displaysleep         10\n"}}
	if r := resultByName(t, opts, "sleep"); r.Status != StatusOK {
		t.Fatalf("darwin off: %+v", r)
	}
	opts.Runner = &fakeRunner{outputs: map[string]string{"pmset -g": " sleep                1\n displaysleep 10\n"}}
	if r := resultByName(t, opts, "sleep"); r.Status != StatusWarn {
		t.Fatalf("darwin on: %+v", r)
	}

	opts.GOOS = "windows"
	opts.Runner = &fakeRunner{outputs: map[string]string{"powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE": "    Current AC Power Setting Index: 0x00000708\r\n    Current DC Power Setting Index: 0x00000384\r\n"}}
	r := resultByName(t, opts, "sleep")
	if r.Status != StatusWarn || !strings.Contains(r.Detail, "30 min") {
		t.Fatalf("windows: %+v", r)
	}
	opts.Runner = &fakeRunner{outputs: map[string]string{"powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE": "    Current AC Power Setting Index: 0x00000000\r\n"}}
	if r := resultByName(t, opts, "sleep"); r.Status != StatusOK {
		t.Fatalf("windows off: %+v", r)
	}
}

func TestTailscale(t *testing.T) {
	opts := baseOptions()
	runner := opts.Runner.(*fakeRunner)
	delete(runner.paths, "tailscale")
	if r := resultByName(t, opts, "tailscale"); r.Status != StatusWarn {
		t.Fatalf("missing: %+v", r)
	}
	if r := resultByName(t, opts, "tailscale-serve"); r.Status != StatusSkip {
		t.Fatalf("serve missing: %+v", r)
	}

	opts = baseOptions()
	runner = opts.Runner.(*fakeRunner)
	runner.outputs["/bin/tailscale status --json"] = `{"BackendState":"NeedsLogin"}`
	r := resultByName(t, opts, "tailscale")
	if r.Status != StatusWarn || !strings.Contains(r.Detail, "NeedsLogin") {
		t.Fatalf("logged out: %+v", r)
	}

	runner.outputs["/bin/tailscale serve status --json"] = `{}`
	if r := resultByName(t, opts, "tailscale-serve"); r.Status != StatusWarn || !strings.Contains(r.Hint, "--https=8317") {
		t.Fatalf("serve absent: %+v", r)
	}
}

func TestServeFrontsPort(t *testing.T) {
	js := []byte(`{"Web":{"a:443":{"Handlers":{"/":{"Proxy":"http://localhost:9000"}}},"b:8317":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8317"}}}}}`)
	if !ServeFrontsPort(js, 8317) || !ServeFrontsPort(js, 9000) || ServeFrontsPort(js, 1234) {
		t.Fatal("ServeFrontsPort mismatch")
	}
}

func TestPort(t *testing.T) {
	opts := baseOptions()
	opts.Ports = fakePorts{free: false}
	opts.HTTP = fakeHTTP{status: map[string]int{"http://127.0.0.1:8317/healthz": 200}, body: map[string]string{"http://127.0.0.1:8317/healthz": `{"status":"ok"}`}}
	if r := resultByName(t, opts, "port"); r.Status != StatusOK || !strings.Contains(r.Detail, "running") {
		t.Fatalf("ours: %+v", r)
	}
	opts.HTTP = fakeHTTP{}
	if r := resultByName(t, opts, "port"); r.Status != StatusFail {
		t.Fatalf("taken: %+v", r)
	}
	opts.Port = 9999
	opts.Ports = fakePorts{free: true}
	if r := resultByName(t, opts, "port"); !strings.Contains(r.Detail, "9999") {
		t.Fatalf("override: %+v", r)
	}
}

func TestConfigChecks(t *testing.T) {
	opts := baseOptions()
	opts.ConfigPath = "/missing.yaml"
	if r := resultByName(t, opts, "config"); r.Status != StatusFail || !strings.Contains(r.Detail, "no config") {
		t.Fatalf("missing: %+v", r)
	}

	write := func(body string) Options {
		o := baseOptions()
		o.FS.(mapFS).m["home/cfg/config.yaml"] = &fstest.MapFile{Data: []byte(body)}
		return o
	}
	if r := resultByName(t, write("server: [unclosed"), "config"); r.Status != StatusFail {
		t.Fatalf("bad yaml: %+v", r)
	}
	r := resultByName(t, write("management:\n  secret-key: replace-me\naccess:\n  api-keys: [replace-with-a-54-char-url-safe-key]\n"), "config")
	if r.Status != StatusFail || !strings.Contains(r.Hint, "placeholder") {
		t.Fatalf("placeholders: %+v", r)
	}
	r = resultByName(t, write("host: 0.0.0.0\napi-keys: [abc]\nrouting:\n  strategy: round-robin\n"), "config")
	if r.Status != StatusWarn || !strings.Contains(r.Hint, "binds 0.0.0.0") || !strings.Contains(r.Detail, "1 API key") {
		t.Fatalf("legacy/warn: %+v", r)
	}
}

func TestDefaultConfigSearch(t *testing.T) {
	opts := baseOptions()
	opts.ConfigPath = ""
	opts.FS.(mapFS).m["home/.local/share/t3code-proxy/config.yaml"] = &fstest.MapFile{Data: []byte(goodConfig)}
	r := resultByName(t, opts, "config")
	if r.Status != StatusOK || !strings.Contains(r.Detail, filepath.Join("/home", ".local", "share", "t3code-proxy", "config.yaml")) {
		t.Fatalf("default search: %+v", r)
	}
}

func TestAuthDir(t *testing.T) {
	opts := baseOptions()
	opts.AuthDir = "/nowhere"
	if r := resultByName(t, opts, "accounts"); r.Status != StatusWarn || !strings.Contains(r.Detail, "missing") {
		t.Fatalf("missing: %+v", r)
	}
	opts = baseOptions()
	m := opts.FS.(mapFS).m
	for k := range m {
		if strings.HasPrefix(k, "home/auths/") {
			delete(m, k)
		}
	}
	m["home/auths/gem.json"] = &fstest.MapFile{Data: []byte(`{"type":"gemini"}`)}
	if r := resultByName(t, opts, "accounts"); r.Status != StatusWarn || !strings.Contains(r.Detail, "gemini 1") {
		t.Fatalf("no claude/codex: %+v", r)
	}
}

func TestServiceAndLinger(t *testing.T) {
	opts := baseOptions()
	runner := opts.Runner.(*fakeRunner)
	runner.outputs["systemctl --user is-active t3code-proxy.service"] = "inactive\n"
	runner.outputs["loginctl show-user daniel --property=Linger"] = "Linger=no\n"
	delete(opts.FS.(mapFS).m, "var/lib/systemd/linger/daniel")
	if r := resultByName(t, opts, "service"); r.Status != StatusWarn {
		t.Fatalf("service: %+v", r)
	}
	if r := resultByName(t, opts, "linger"); r.Status != StatusWarn || !strings.Contains(r.Hint, "enable-linger daniel") {
		t.Fatalf("linger: %+v", r)
	}

	opts.GOOS = "darwin"
	opts.Runner = &fakeRunner{outputs: map[string]string{"launchctl list com.t3code-proxy.hub": "{}"}}
	if r := resultByName(t, opts, "service"); r.Status != StatusOK {
		t.Fatalf("launchd: %+v", r)
	}
	if r := resultByName(t, opts, "linger"); r.Status != StatusSkip {
		t.Fatalf("linger darwin: %+v", r)
	}
	opts.GOOS = "windows"
	opts.Runner = &fakeRunner{errs: map[string]error{"schtasks /Query /TN t3code-proxy": fs.ErrNotExist}}
	if r := resultByName(t, opts, "service"); r.Status != StatusWarn {
		t.Fatalf("schtasks: %+v", r)
	}
}

func TestMainFlags(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Main(context.Background(), []string{"-bogus"}, &out, &errOut); code != 2 {
		t.Fatalf("bogus flag exit = %d", code)
	}
	if code := Main(context.Background(), []string{"extra"}, &out, &errOut); code != 2 {
		t.Fatalf("extra arg exit = %d", code)
	}
}

func TestTextAlignment(t *testing.T) {
	var buf bytes.Buffer
	writeText(&buf, true, []Result{
		{Name: "a", Status: StatusOK, Detail: "one"},
		{Name: "longer", Status: StatusWarn, Detail: "two", Hint: "do x"},
	})
	lines := strings.Split(buf.String(), "\n")
	if lines[0] != "ok    a       one" || lines[1] != "warn  longer  two (fix: do x)" {
		t.Fatalf("unexpected layout:\n%q", lines[:2])
	}
}

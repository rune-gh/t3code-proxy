// Package doctor checks whether a machine is ready to act as a t3code-proxy hub
// and prints one line per check with a short fix hint.
//
// Entry points:
//
//	Main(ctx, args, stdout, stderr) int  // parses flags, runs checks, returns an exit code
//	Run(ctx, out, opts) bool             // runs checks with explicit Options
//
// Flags accepted by Main (single or double dash):
//
//	-config <path>   config file to inspect (default: ./config.yaml, then the
//	                 installer location, see DefaultConfigPaths)
//	-auth-dir <path> auth directory override (default: oauth.auth-dir from the
//	                 config, then ~/.t3code-proxy, or an
//	                 existing ~/.cli-proxy-api)
//	-port <n>        port to check (default: server.port from the config, then 8317)
//	-json            print a JSON report instead of aligned text
//	-offline         skip the public network (ipinfo.io) lookup
//	-check-config    use the production config loader without starting services
//	                 or modifying source files, and print a redacted JSON report
//	-probe-url <url> with -check-config, probe an existing loopback HTTP hub
//	-management-key-file <path> plaintext key file when config holds a hash
//
// Exit codes from Main: 0 when no check failed (warnings allowed), 1 when at
// least one check failed, 2 on a usage error.
//
// The checks never print secrets: the management secret and API keys are only
// reported as set or not set. External commands and HTTP requests use short
// timeouts because this is a diagnostic, not proxy traffic.
package doctor

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/MoeForge/moego/ojson"
)

// Status is the outcome of a single check.
type Status string

// Check outcomes. Only StatusFail makes the overall result not ok.
const (
	StatusOK   Status = "ok"
	StatusWarn Status = "warn"
	StatusFail Status = "fail"
	StatusSkip Status = "skip"
)

// DefaultPort is the hub port used when the config does not set one.
const DefaultPort = 8317

// Result is the outcome of one check.
type Result struct {
	Name   string
	Status Status
	Detail string
	Hint   string
}

// Options configures a doctor run. Zero-valued dependencies use the real
// operating system implementations.
type Options struct {
	ConfigPath string
	AuthDir    string
	Port       int
	JSON       bool
	Offline    bool

	GOOS     string
	GOARCH   string
	HomeDir  string
	Username string

	Runner Runner
	HTTP   HTTPGetter
	Ports  PortProber
	Clock  Clock
	FS     FileSystem
}

// env holds the resolved options shared by all checks.
type env struct {
	Options
	cfg     *hubConfig
	cfgPath string
	cfgErr  error
}

// Main parses doctor flags from args, runs every check, and writes the report
// to stdout. It returns the process exit code.
func Main(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var opts Options
	var configOnly bool
	var probeURL, managementKeyFile string
	fs.BoolVar(&configOnly, "check-config", false, "validate with the server loader on a temporary copy, without starting services (JSON output)")
	fs.StringVar(&probeURL, "probe-url", "", "with -check-config, probe an existing loopback hub using config keys")
	fs.StringVar(&managementKeyFile, "management-key-file", "", "plaintext management key file for -probe-url when config holds a hash")
	fs.StringVar(&opts.ConfigPath, "config", "", "config file to inspect")
	fs.StringVar(&opts.AuthDir, "auth-dir", "", "auth directory override")
	fs.IntVar(&opts.Port, "port", 0, "port to check (default from config, then 8317)")
	fs.BoolVar(&opts.JSON, "json", false, "print a JSON report")
	fs.BoolVar(&opts.Offline, "offline", false, "skip the public network lookup")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		_, _ = fmt.Fprintf(stderr, "doctor: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	if configOnly {
		if checkConfigCommand(ctx, opts.ConfigPath, probeURL, managementKeyFile, stdout) {
			return 0
		}
		return 1
	}
	if probeURL != "" || managementKeyFile != "" {
		_, _ = fmt.Fprintln(stderr, "doctor: probe flags require -check-config")
		return 2
	}
	if Run(ctx, stdout, opts) {
		return 0
	}
	return 1
}

// Run executes every check and writes the report to out. It returns false when
// at least one check failed.
func Run(ctx context.Context, out io.Writer, opts Options) bool {
	e := newEnv(opts)
	results := runChecks(ctx, e)
	ok := true
	for _, r := range results {
		if r.Status == StatusFail {
			ok = false
		}
	}
	if e.JSON {
		writeJSON(out, e.Clock.Now(), ok, results)
	} else {
		writeText(out, ok, results)
	}
	return ok
}

func newEnv(opts Options) *env {
	if opts.GOOS == "" {
		opts.GOOS = runtime.GOOS
	}
	if opts.GOARCH == "" {
		opts.GOARCH = runtime.GOARCH
	}
	if opts.HomeDir == "" {
		opts.HomeDir, _ = os.UserHomeDir()
	}
	if opts.Username == "" {
		opts.Username = firstNonEmpty(os.Getenv("USER"), os.Getenv("USERNAME"), os.Getenv("LOGNAME"))
	}
	if opts.Runner == nil {
		opts.Runner = execRunner{}
	}
	if opts.HTTP == nil {
		opts.HTTP = httpGetter{client: &http.Client{Timeout: httpTimeout}}
	}
	if opts.Ports == nil {
		opts.Ports = netProber{}
	}
	if opts.Clock == nil {
		opts.Clock = systemClock{}
	}
	if opts.FS == nil {
		opts.FS = osFS{}
	}
	e := &env{Options: opts}
	e.cfgPath, e.cfg, e.cfgErr = loadConfig(e)
	if e.Port == 0 {
		e.Port = DefaultPort
		if e.cfg != nil && e.cfg.Server.Port > 0 {
			e.Port = e.cfg.Server.Port
		}
	}
	return e
}

// runChecks runs every check in display order.
func runChecks(ctx context.Context, e *env) []Result {
	return []Result{
		checkOS(e),
		checkNetwork(ctx, e),
		checkSleep(ctx, e),
		checkTailscale(ctx, e),
		checkTailscaleServe(ctx, e),
		checkPort(ctx, e),
		checkConfig(e),
		checkAuthDir(e),
		checkService(ctx, e),
		checkLinger(ctx, e),
	}
}

// DefaultConfigPaths lists the config locations tried when -config is not
// given, in order: the working directory, then the installer's location.
func DefaultConfigPaths(goos, home string) []string {
	paths := []string{"config.yaml"}
	if home == "" {
		return paths
	}
	return append(paths, filepath.Join(InstallDir(goos, home), "config.yaml"))
}

// InstallDir is where the installers put the binary, config, and logs.
func InstallDir(goos, home string) string {
	if goos == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "t3code-proxy")
	}
	return filepath.Join(home, ".local", "share", "t3code-proxy")
}

func checkOS(e *env) Result {
	r := Result{Name: "os", Detail: e.GOOS + "/" + e.GOARCH}
	switch e.GOOS {
	case "linux", "darwin", "windows":
		r.Status = StatusOK
	default:
		r.Status = StatusWarn
		r.Hint = "only Linux, macOS, and Windows are supported hub platforms"
	}
	return r
}

func checkPort(ctx context.Context, e *env) Result {
	addr := "127.0.0.1:" + strconv.Itoa(e.Port)
	r := Result{Name: "port"}
	if e.Ports.CanListen(addr) {
		r.Status, r.Detail = StatusOK, addr+" is free"
		return r
	}
	status, body, err := e.HTTP.Get(ctx, "http://"+addr+"/healthz")
	if err == nil && status == http.StatusOK && ojson.GetBytes(body, "status").String() == "ok" {
		r.Status, r.Detail = StatusOK, addr+" is served by a running t3code-proxy"
		return r
	}
	r.Status = StatusFail
	r.Detail = addr + " is in use by another program"
	r.Hint = "stop the other program or change server.port in the config"
	return r
}

func writeText(out io.Writer, ok bool, results []Result) {
	width := 0
	for _, r := range results {
		width = max(width, len(r.Name))
	}
	for _, r := range results {
		line := fmt.Sprintf("%-4s  %-*s  %s", r.Status, width, r.Name, r.Detail)
		if r.Hint != "" && r.Status != StatusOK {
			line += " (fix: " + r.Hint + ")"
		}
		_, _ = fmt.Fprintln(out, strings.TrimRight(line, " "))
	}
	if ok {
		_, _ = fmt.Fprintln(out, "\nNo failures. Warnings are worth fixing on an always-on hub.")
	} else {
		_, _ = fmt.Fprintln(out, "\nAt least one check failed. Fix the failures above before relying on this hub.")
	}
}

func writeJSON(out io.Writer, now time.Time, ok bool, results []Result) {
	doc := ojson.NewDocString(`{"ok":false,"time":"","checks":[]}`)
	_ = doc.Set("ok", ok)
	_ = doc.Set("time", now.UTC().Format(time.RFC3339))
	for i, r := range results {
		p := "checks." + strconv.Itoa(i) + "."
		_ = doc.Set(p+"name", r.Name)
		_ = doc.Set(p+"status", string(r.Status))
		_ = doc.Set(p+"detail", r.Detail)
		if r.Hint != "" {
			_ = doc.Set(p+"hint", r.Hint)
		}
	}
	_, _ = out.Write(doc.Bytes())
	_, _ = fmt.Fprintln(out)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

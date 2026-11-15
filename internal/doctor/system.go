package doctor

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/MoeForge/moego/ojson"
)

// ipinfoOrgURL returns the network organisation of the public IP as plain text.
const ipinfoOrgURL = "https://ipinfo.io/org"

// datacenterMarkers are lower-case substrings of network org names that belong
// to cloud or hosting providers. Subscription logins from these networks are
// likely to be flagged, so the hub must run on a residential connection.
var datacenterMarkers = []string{
	"amazon", "aws", "google llc", "google cloud", "microsoft", "azure",
	"hetzner", "digitalocean", "ovh", "linode", "akamai", "vultr", "choopa", "constant company",
	"oracle", "scaleway", "online s.a.s", "contabo", "alibaba", "tencent",
	"leaseweb", "hostinger", "ionos", "upcloud", "kamatera", "hostwinds",
	"m247", "datacamp", "cloudflare", "fly.io", "equinix", "servers.com",
	"psychz", "quadranet", "colocrossing", "netcup", "racknerd", "buyvm",
	"frantech", "gcore", "g-core", "cherry servers", "hivelocity",
}

// IsDatacenterOrg reports whether an ipinfo org string looks like a cloud or
// hosting provider rather than a residential ISP.
func IsDatacenterOrg(org string) bool {
	o := strings.ToLower(org)
	words := map[string]bool{}
	for _, w := range strings.FieldsFunc(o, func(c rune) bool {
		return (c < 'a' || c > 'z') && (c < '0' || c > '9')
	}) {
		words[w] = true
	}
	for _, m := range datacenterMarkers {
		// Short markers must match a whole word so "aws" does not hit "Lawson".
		if len(m) <= 4 {
			if words[m] {
				return true
			}
			continue
		}
		if strings.Contains(o, m) {
			return true
		}
	}
	return false
}

func checkNetwork(ctx context.Context, e *env) Result {
	r := Result{Name: "network"}
	if e.Offline {
		r.Status, r.Detail = StatusSkip, "skipped (-offline)"
		return r
	}
	status, body, err := e.HTTP.Get(ctx, ipinfoOrgURL)
	if err != nil || status != http.StatusOK {
		r.Status = StatusWarn
		r.Detail = "could not reach ipinfo.io to identify the network"
		r.Hint = "check internet access, or run: curl -s https://ipinfo.io/org"
		return r
	}
	org := strings.TrimSpace(string(body))
	if org == "" {
		r.Status, r.Detail = StatusWarn, "ipinfo.io returned no network org"
		r.Hint = "run: curl -s https://ipinfo.io/org"
		return r
	}
	r.Detail = org
	if IsDatacenterOrg(org) {
		r.Status = StatusFail
		r.Detail = org + " looks like a datacenter network"
		r.Hint = "do not sign subscriptions in from a datacenter IP; run the hub on a home connection"
		return r
	}
	r.Status = StatusOK
	return r
}

func checkSleep(ctx context.Context, e *env) Result {
	r := Result{Name: "sleep"}
	switch e.GOOS {
	case "linux":
		if _, err := e.Runner.LookPath("systemctl"); err != nil {
			r.Status, r.Detail = StatusSkip, "systemctl not found"
			return r
		}
		// is-enabled exits non-zero for masked units; the output is what matters.
		out, _ := e.Runner.Run(ctx, "systemctl", "is-enabled", "sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target")
		lines := strings.Fields(string(out))
		masked := 0
		for _, l := range lines {
			if l == "masked" {
				masked++
			}
		}
		if len(lines) > 0 && masked == len(lines) {
			r.Status, r.Detail = StatusOK, "sleep and suspend targets are masked"
			return r
		}
		r.Status, r.Detail = StatusWarn, "the machine may suspend"
		r.Hint = "sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target"
	case "darwin":
		out, err := e.Runner.Run(ctx, "pmset", "-g")
		if err != nil {
			r.Status, r.Detail = StatusSkip, "pmset unavailable"
			return r
		}
		minutes, found := parsePmsetSleep(string(out))
		if !found {
			r.Status, r.Detail = StatusWarn, "could not read the system sleep setting"
			r.Hint = "check: pmset -g | grep sleep"
			return r
		}
		if minutes == 0 {
			r.Status, r.Detail = StatusOK, "system sleep is disabled"
			return r
		}
		r.Status, r.Detail = StatusWarn, "system sleeps after "+strconv.Itoa(minutes)+" min idle"
		r.Hint = "sudo pmset -c sleep 0"
	case "windows":
		out, err := e.Runner.Run(ctx, "powercfg", "/query", "SCHEME_CURRENT", "SUB_SLEEP", "STANDBYIDLE")
		if err != nil {
			r.Status, r.Detail = StatusSkip, "powercfg unavailable"
			return r
		}
		seconds, found := parsePowercfgAC(string(out))
		if !found {
			r.Status, r.Detail = StatusWarn, "could not read the standby timeout"
			r.Hint = "check: powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE"
			return r
		}
		if seconds == 0 {
			r.Status, r.Detail = StatusOK, "standby on AC power is disabled"
			return r
		}
		r.Status, r.Detail = StatusWarn, "standby on AC power after "+strconv.Itoa(seconds/60)+" min"
		r.Hint = "powercfg /change standby-timeout-ac 0"
	default:
		r.Status, r.Detail = StatusSkip, "not checked on "+e.GOOS
	}
	return r
}

// parsePmsetSleep extracts the system "sleep" minutes from `pmset -g` output.
func parsePmsetSleep(out string) (int, bool) {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == "sleep" {
			n, err := strconv.Atoi(f[1])
			if err == nil {
				return n, true
			}
		}
	}
	return 0, false
}

// parsePowercfgAC extracts the AC power setting index (seconds) from powercfg output.
func parsePowercfgAC(out string) (int, bool) {
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "Current AC Power Setting Index:") {
			continue
		}
		v := strings.TrimSpace(line[strings.LastIndex(line, ":")+1:])
		n, err := strconv.ParseInt(strings.TrimPrefix(v, "0x"), 16, 64)
		if err == nil {
			return int(n), true
		}
	}
	return 0, false
}

// tailscaleBinary finds the tailscale CLI, including the macOS app bundle path.
func tailscaleBinary(e *env) string {
	if p, err := e.Runner.LookPath("tailscale"); err == nil {
		return p
	}
	if e.GOOS == "darwin" {
		const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
		if _, err := e.FS.Stat(app); err == nil {
			return app
		}
	}
	return ""
}

func checkTailscale(ctx context.Context, e *env) Result {
	r := Result{Name: "tailscale"}
	bin := tailscaleBinary(e)
	if bin == "" {
		r.Status, r.Detail = StatusWarn, "tailscale is not installed"
		r.Hint = "install Tailscale from https://tailscale.com/download to reach the hub from other machines"
		return r
	}
	out, _ := e.Runner.Run(ctx, bin, "status", "--json")
	state := ojson.GetBytes(out, "BackendState").String()
	if state != "Running" {
		r.Status = StatusWarn
		r.Detail = "tailscale is installed but not connected"
		if state != "" {
			r.Detail += " (state " + state + ")"
		}
		r.Hint = "run: tailscale up"
		return r
	}
	r.Status = StatusOK
	r.Detail = "connected"
	if name := strings.TrimSuffix(ojson.GetBytes(out, "Self.DNSName").String(), "."); name != "" {
		r.Detail += " as " + name
	}
	return r
}

func checkTailscaleServe(ctx context.Context, e *env) Result {
	r := Result{Name: "tailscale-serve"}
	port := strconv.Itoa(e.Port)
	hint := "tailscale serve --bg --https=" + port + " http://127.0.0.1:" + port
	bin := tailscaleBinary(e)
	if bin == "" {
		r.Status, r.Detail = StatusSkip, "tailscale is not installed"
		return r
	}
	out, err := e.Runner.Run(ctx, bin, "serve", "status", "--json")
	if err != nil || !ojson.ValidBytes(out) {
		r.Status, r.Detail, r.Hint = StatusWarn, "could not read tailscale serve status", hint
		return r
	}
	if ServeFrontsPort(out, e.Port) {
		r.Status, r.Detail = StatusOK, "tailscale serve forwards to 127.0.0.1:"+port
		return r
	}
	r.Status, r.Detail, r.Hint = StatusWarn, "tailscale serve does not front port "+port, hint
	return r
}

// ServeFrontsPort reports whether `tailscale serve status --json` output has a
// web handler proxying to the local port.
func ServeFrontsPort(statusJSON []byte, port int) bool {
	suffix := ":" + strconv.Itoa(port)
	found := false
	ojson.GetBytes(statusJSON, "Web").ForEach(func(_, site ojson.Result) bool {
		site.Get("Handlers").ForEach(func(_, h ojson.Result) bool {
			proxy := strings.TrimSuffix(h.Get("Proxy").String(), "/")
			for _, host := range []string{"127.0.0.1", "localhost", "[::1]"} {
				if proxy == "http://"+host+suffix || proxy == host+suffix || proxy == suffix[1:] {
					found = true
				}
			}
			return !found
		})
		return !found
	})
	return found
}

func checkService(ctx context.Context, e *env) Result {
	r := Result{Name: "service"}
	switch e.GOOS {
	case "linux":
		if _, err := e.Runner.LookPath("systemctl"); err != nil {
			r.Status, r.Detail = StatusSkip, "systemctl not found"
			return r
		}
		out, _ := e.Runner.Run(ctx, "systemctl", "--user", "is-active", "t3code-proxy.service")
		state := strings.TrimSpace(string(out))
		if state == "active" {
			r.Status, r.Detail = StatusOK, "systemd user service is active"
			return r
		}
		r.Status, r.Detail = StatusWarn, "systemd user service is not active ("+firstNonEmpty(state, "unknown")+")"
		r.Hint = "run scripts/install.sh, or: systemctl --user enable --now t3code-proxy"
	case "darwin":
		if _, err := e.Runner.Run(ctx, "launchctl", "list", "com.t3code-proxy.hub"); err == nil {
			r.Status, r.Detail = StatusOK, "launchd agent com.t3code-proxy.hub is loaded"
			return r
		}
		r.Status, r.Detail = StatusWarn, "launchd agent com.t3code-proxy.hub is not loaded"
		r.Hint = "run scripts/install.sh"
	case "windows":
		if _, err := e.Runner.Run(ctx, "schtasks", "/Query", "/TN", "t3code-proxy"); err == nil {
			r.Status, r.Detail = StatusOK, "scheduled task t3code-proxy exists"
			return r
		}
		r.Status, r.Detail = StatusWarn, "scheduled task t3code-proxy not found"
		r.Hint = "run scripts/install.ps1"
	default:
		r.Status, r.Detail = StatusSkip, "not checked on "+e.GOOS
	}
	return r
}

func checkLinger(ctx context.Context, e *env) Result {
	r := Result{Name: "linger"}
	if e.GOOS != "linux" {
		r.Status, r.Detail = StatusSkip, "only relevant on Linux"
		return r
	}
	if e.Username == "" {
		r.Status, r.Detail = StatusWarn, "could not determine the current user"
		r.Hint = "loginctl enable-linger \"$USER\""
		return r
	}
	enabled := false
	if _, err := e.Runner.LookPath("loginctl"); err == nil {
		out, _ := e.Runner.Run(ctx, "loginctl", "show-user", e.Username, "--property=Linger")
		enabled = strings.TrimSpace(string(out)) == "Linger=yes"
	}
	if !enabled {
		if _, err := e.FS.Stat("/var/lib/systemd/linger/" + e.Username); err == nil {
			enabled = true
		}
	}
	if enabled {
		r.Status, r.Detail = StatusOK, "linger is enabled for "+e.Username
		return r
	}
	r.Status, r.Detail = StatusWarn, "linger is off, so the user service stops at logout"
	r.Hint = "sudo loginctl enable-linger " + e.Username
	return r
}

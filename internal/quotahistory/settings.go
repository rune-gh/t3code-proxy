// Package quotahistory records the remaining quota of Claude and Codex OAuth
// credentials over time so the management panel can chart and project it.
//
// It is a t3code fork addition. When quota-history.enabled is false nothing is
// polled, opened or written.
package quotahistory

import (
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/util"
	log "github.com/sirupsen/logrus"
)

const (
	// DefaultInterval is the poll interval used when none is configured.
	DefaultInterval = 10 * time.Minute
	// MinInterval is the smallest accepted poll interval.
	MinInterval = 5 * time.Minute
	// DefaultRetention is how long samples are kept when none is configured.
	DefaultRetention = 35 * 24 * time.Hour
	// MinRetention is the smallest accepted retention.
	MinRetention = 24 * time.Hour
	// DefaultFileName is the database file name placed next to the config file.
	DefaultFileName = "quota-history.db"
)

// Settings is the resolved recorder configuration.
type Settings struct {
	Enabled   bool
	Interval  time.Duration
	Retention time.Duration
	Path      string
}

// SettingsFromConfig resolves the quota-history section of cfg. Invalid or
// missing durations fall back to their defaults (with a warning) and are
// clamped to the minimums. A database path inside auth-dir is an error because
// the auth watcher owns that directory.
func SettingsFromConfig(cfg *config.Config, configFilePath string) (Settings, error) {
	s := Settings{Interval: DefaultInterval, Retention: DefaultRetention}
	if cfg == nil {
		return s, nil
	}
	qh := cfg.QuotaHistory
	s.Enabled = qh.Enabled
	if d, ok := parseDuration(qh.Interval); ok {
		s.Interval = d
	} else if strings.TrimSpace(qh.Interval) != "" {
		log.Warnf("quota-history: invalid interval %q, using %s", qh.Interval, DefaultInterval)
	}
	if s.Interval < MinInterval {
		s.Interval = MinInterval
	}
	if d, ok := parseDuration(qh.Retention); ok {
		s.Retention = d
	} else if strings.TrimSpace(qh.Retention) != "" {
		log.Warnf("quota-history: invalid retention %q, using %s", qh.Retention, DefaultRetention)
	}
	if s.Retention < MinRetention {
		s.Retention = MinRetention
	}

	baseDir := "."
	if strings.TrimSpace(configFilePath) != "" {
		baseDir = filepath.Dir(configFilePath)
	}
	path := strings.TrimSpace(qh.Path)
	switch {
	case path == "":
		path = filepath.Join(baseDir, DefaultFileName)
	case strings.HasPrefix(path, "~"):
		// ResolveAuthDir only expands a leading "~" for non-empty input.
		expanded, errExpand := util.ResolveAuthDir(path)
		if errExpand != nil {
			return s, fmt.Errorf("quota-history: %w", errExpand)
		}
		path = expanded
	case !filepath.IsAbs(path):
		path = filepath.Join(baseDir, path)
	}
	absPath, errAbs := filepath.Abs(path)
	if errAbs != nil {
		return s, fmt.Errorf("quota-history: resolve path: %w", errAbs)
	}
	s.Path = absPath

	if authDir, errAuth := util.ResolveAuthDir(cfg.AuthDir); errAuth == nil {
		if absAuth, errAbsAuth := filepath.Abs(authDir); errAbsAuth == nil && isWithin(absAuth, absPath) {
			return s, fmt.Errorf("quota-history: path %q must not be inside auth-dir %q", absPath, absAuth)
		}
	}
	return s, nil
}

// parseDuration accepts Go durations plus a "<n>d" day suffix.
func parseDuration(raw string) (time.Duration, bool) {
	raw = strings.ToLower(strings.TrimSpace(raw))
	if raw == "" {
		return 0, false
	}
	if days, found := strings.CutSuffix(raw, "d"); found {
		n, errParse := strconv.ParseFloat(days, 64)
		if errParse != nil || n <= 0 {
			return 0, false
		}
		return time.Duration(n * float64(24*time.Hour)), true
	}
	d, errParse := time.ParseDuration(raw)
	if errParse != nil || d <= 0 {
		return 0, false
	}
	return d, true
}

func isWithin(dir, path string) bool {
	rel, errRel := filepath.Rel(dir, path)
	if errRel != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

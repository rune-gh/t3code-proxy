package config

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	log "github.com/sirupsen/logrus"
)

// defaultAuthDirUserHome looks up the user's home directory. Tests replace it
// to avoid touching the real home directory.
var defaultAuthDirUserHome = os.UserHomeDir

var defaultAuthDirState struct {
	sync.Mutex
	resolved bool
	value    string
}

// EffectiveDefaultAuthDir returns the auth directory to use when the config does
// not set auth-dir. New installs use DefaultAuthDir; when that directory does not
// exist but LegacyAuthDir does, the legacy directory keeps being used so existing
// installs continue to find their credentials. The result is in "~/..." form and
// is decided once per process so it cannot flip while the server is running.
func EffectiveDefaultAuthDir() string {
	defaultAuthDirState.Lock()
	defer defaultAuthDirState.Unlock()
	if defaultAuthDirState.resolved {
		return defaultAuthDirState.value
	}
	value := chooseDefaultAuthDir(defaultAuthDirUserHome)
	if value == LegacyAuthDir {
		log.Infof("using legacy auth directory %s because %s does not exist; set auth-dir in the config to choose explicitly", LegacyAuthDir, DefaultAuthDir)
	}
	defaultAuthDirState.value = value
	defaultAuthDirState.resolved = true
	return value
}

// chooseDefaultAuthDir picks DefaultAuthDir or LegacyAuthDir based on which
// directories exist under the home directory returned by userHome.
func chooseDefaultAuthDir(userHome func() (string, error)) string {
	if userHome == nil {
		return DefaultAuthDir
	}
	home, errHome := userHome()
	if errHome != nil || strings.TrimSpace(home) == "" {
		return DefaultAuthDir
	}
	if dirExists(expandHomeRelative(home, DefaultAuthDir)) {
		return DefaultAuthDir
	}
	if dirExists(expandHomeRelative(home, LegacyAuthDir)) {
		return LegacyAuthDir
	}
	return DefaultAuthDir
}

// expandHomeRelative expands a "~/name" path against home.
func expandHomeRelative(home, path string) string {
	remainder := strings.TrimLeft(strings.TrimPrefix(path, "~"), "/\\")
	return filepath.Join(home, filepath.FromSlash(remainder))
}

func dirExists(path string) bool {
	info, errStat := os.Stat(path)
	return errStat == nil && info.IsDir()
}

// SetDefaultAuthDirHomeForTesting clears the cached default auth directory decision
// and installs userHome as the home directory lookup. It returns a function that
// restores the previous state. Intended for tests in other packages.
func SetDefaultAuthDirHomeForTesting(userHome func() (string, error)) func() {
	defaultAuthDirState.Lock()
	prevHome := defaultAuthDirUserHome
	prevResolved := defaultAuthDirState.resolved
	prevValue := defaultAuthDirState.value
	defaultAuthDirUserHome = userHome
	defaultAuthDirState.resolved = false
	defaultAuthDirState.value = ""
	defaultAuthDirState.Unlock()
	return func() {
		defaultAuthDirState.Lock()
		defaultAuthDirUserHome = prevHome
		defaultAuthDirState.resolved = prevResolved
		defaultAuthDirState.value = prevValue
		defaultAuthDirState.Unlock()
	}
}

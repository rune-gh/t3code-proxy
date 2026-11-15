package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func tempHome(t *testing.T, dirs ...string) func() (string, error) {
	t.Helper()
	home := t.TempDir()
	for _, dir := range dirs {
		if errMkdir := os.MkdirAll(filepath.Join(home, dir), 0o700); errMkdir != nil {
			t.Fatalf("mkdir %s: %v", dir, errMkdir)
		}
	}
	return func() (string, error) { return home, nil }
}

func TestChooseDefaultAuthDir(t *testing.T) {
	tests := []struct {
		name string
		dirs []string
		want string
	}{
		{name: "fresh install uses new directory", want: DefaultAuthDir},
		{name: "only legacy directory exists", dirs: []string{".cli-proxy-api"}, want: LegacyAuthDir},
		{name: "only new directory exists", dirs: []string{".t3code-proxy"}, want: DefaultAuthDir},
		{name: "both exist prefers new directory", dirs: []string{".t3code-proxy", ".cli-proxy-api"}, want: DefaultAuthDir},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := chooseDefaultAuthDir(tempHome(t, tt.dirs...)); got != tt.want {
				t.Fatalf("chooseDefaultAuthDir() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestChooseDefaultAuthDir_LegacyFileIsNotDirectory(t *testing.T) {
	home := t.TempDir()
	if errWrite := os.WriteFile(filepath.Join(home, ".cli-proxy-api"), []byte("x"), 0o600); errWrite != nil {
		t.Fatalf("write: %v", errWrite)
	}
	got := chooseDefaultAuthDir(func() (string, error) { return home, nil })
	if got != DefaultAuthDir {
		t.Fatalf("chooseDefaultAuthDir() = %q, want %q", got, DefaultAuthDir)
	}
}

func TestChooseDefaultAuthDir_HomeLookupFails(t *testing.T) {
	got := chooseDefaultAuthDir(func() (string, error) { return "", errors.New("no home") })
	if got != DefaultAuthDir {
		t.Fatalf("chooseDefaultAuthDir() = %q, want %q", got, DefaultAuthDir)
	}
}

func TestEffectiveDefaultAuthDir_CachesDecision(t *testing.T) {
	home := t.TempDir()
	if errMkdir := os.MkdirAll(filepath.Join(home, ".cli-proxy-api"), 0o700); errMkdir != nil {
		t.Fatalf("mkdir: %v", errMkdir)
	}
	restore := SetDefaultAuthDirHomeForTesting(func() (string, error) { return home, nil })
	defer restore()

	if got := EffectiveDefaultAuthDir(); got != LegacyAuthDir {
		t.Fatalf("EffectiveDefaultAuthDir() = %q, want %q", got, LegacyAuthDir)
	}
	// Creating the new directory later in the same process must not flip the choice.
	if errMkdir := os.MkdirAll(filepath.Join(home, ".t3code-proxy"), 0o700); errMkdir != nil {
		t.Fatalf("mkdir: %v", errMkdir)
	}
	if got := EffectiveDefaultAuthDir(); got != LegacyAuthDir {
		t.Fatalf("EffectiveDefaultAuthDir() second call = %q, want %q", got, LegacyAuthDir)
	}
}

func TestEffectiveKVStorePath_UsesLegacyDefaultAuthDir(t *testing.T) {
	restore := SetDefaultAuthDirHomeForTesting(tempHome(t, ".cli-proxy-api"))
	defer restore()

	cfg := &Config{}
	if got, want := cfg.EffectiveKVStorePath(), filepath.Join(LegacyAuthDir, DefaultKVStorePath); got != want {
		t.Fatalf("EffectiveKVStorePath() = %q, want %q", got, want)
	}
	cfg.AuthDir = "/explicit/auth"
	if got, want := cfg.EffectiveKVStorePath(), filepath.Join("/explicit/auth", DefaultKVStorePath); got != want {
		t.Fatalf("EffectiveKVStorePath() explicit = %q, want %q", got, want)
	}
}

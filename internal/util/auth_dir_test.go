package util

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/config"
)

func TestResolveAuthDir_DefaultFallsBackToLegacyDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	if errMkdir := os.MkdirAll(filepath.Join(home, ".cli-proxy-api"), 0o700); errMkdir != nil {
		t.Fatalf("mkdir: %v", errMkdir)
	}
	restore := config.SetDefaultAuthDirHomeForTesting(func() (string, error) { return home, nil })
	defer restore()

	got, errResolve := ResolveAuthDir("")
	if errResolve != nil {
		t.Fatalf("ResolveAuthDir() error = %v", errResolve)
	}
	if want := filepath.Join(home, ".cli-proxy-api"); got != want {
		t.Fatalf("ResolveAuthDir(\"\") = %q, want %q", got, want)
	}
}

func TestResolveAuthDir_DefaultForNewInstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	restore := config.SetDefaultAuthDirHomeForTesting(func() (string, error) { return home, nil })
	defer restore()

	got, errResolve := ResolveAuthDir("")
	if errResolve != nil {
		t.Fatalf("ResolveAuthDir() error = %v", errResolve)
	}
	if want := filepath.Join(home, ".t3code-proxy"); got != want {
		t.Fatalf("ResolveAuthDir(\"\") = %q, want %q", got, want)
	}
}

func TestResolveAuthDir_ExplicitWins(t *testing.T) {
	home := t.TempDir()
	if errMkdir := os.MkdirAll(filepath.Join(home, ".cli-proxy-api"), 0o700); errMkdir != nil {
		t.Fatalf("mkdir: %v", errMkdir)
	}
	restore := config.SetDefaultAuthDirHomeForTesting(func() (string, error) { return home, nil })
	defer restore()

	explicit := filepath.Join(t.TempDir(), "auths")
	got, errResolve := ResolveAuthDir(explicit)
	if errResolve != nil {
		t.Fatalf("ResolveAuthDir() error = %v", errResolve)
	}
	if got != filepath.Clean(explicit) {
		t.Fatalf("ResolveAuthDir(%q) = %q, want explicit path", explicit, got)
	}
}

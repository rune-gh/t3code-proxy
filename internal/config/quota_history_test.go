package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestQuotaHistorySectionLoads(t *testing.T) {
	data := []byte("config-version: 8\nquota-history:\n  enabled: true\n  interval: 15m\n  retention: 30d\n  path: qh.db\n")
	if errValidate := ValidateV8Config(data); errValidate != nil {
		t.Fatalf("quota-history must be a valid v8 section: %v", errValidate)
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	if errWrite := os.WriteFile(path, data, 0o600); errWrite != nil {
		t.Fatal(errWrite)
	}
	cfg, errLoad := LoadConfig(path)
	if errLoad != nil {
		t.Fatal(errLoad)
	}
	want := QuotaHistoryConfig{Enabled: true, Interval: "15m", Retention: "30d", Path: "qh.db"}
	if cfg.QuotaHistory != want {
		t.Fatalf("QuotaHistory = %+v, want %+v", cfg.QuotaHistory, want)
	}
	after, errRead := os.ReadFile(path)
	if errRead != nil {
		t.Fatal(errRead)
	}
	if strings.Contains(string(after), "# quota-history") {
		t.Fatalf("quota-history was commented out on load:\n%s", after)
	}
}

package config

import (
	"fmt"
	"strings"

	"filippo.io/age"
)

type TraceArchiveConfig struct {
	Enabled          bool              `yaml:"enabled" json:"enabled"`
	Dir              string            `yaml:"dir,omitempty" json:"dir"`
	Recipients       []string          `yaml:"recipients,omitempty" json:"recipients"`
	QueueSize        int               `yaml:"queue-size,omitempty" json:"queue-size"`
	MaxLocalSizeMB   int64             `yaml:"max-local-size-mb,omitempty" json:"max-local-size-mb"`
	ExcludeModels    []string          `yaml:"exclude-models,omitempty" json:"exclude-models"`
	ExcludeEndpoints []string          `yaml:"exclude-endpoints,omitempty" json:"exclude-endpoints"`
	Upload           TraceUploadConfig `yaml:"upload,omitempty" json:"upload"`
}

type TraceUploadConfig struct {
	Enabled bool   `yaml:"enabled" json:"enabled"`
	Binary  string `yaml:"binary,omitempty" json:"binary"`
	Remote  string `yaml:"remote,omitempty" json:"remote"`
}

func (c TraceArchiveConfig) Validate() error {
	if c.QueueSize < 0 || c.QueueSize > 65536 || c.MaxLocalSizeMB < 0 || c.MaxLocalSizeMB > 1<<40 {
		return fmt.Errorf("trace-archive: invalid queue-size or max-local-size-mb")
	}
	for _, key := range c.Recipients {
		if _, err := age.ParseX25519Recipient(key); err != nil {
			return fmt.Errorf("trace-archive: invalid X25519 recipient")
		}
	}
	if c.Upload.Enabled && (strings.TrimSpace(c.Upload.Remote) == "" || strings.HasPrefix(c.Upload.Remote, "-")) {
		return fmt.Errorf("trace-archive: upload.remote is required")
	}
	return nil
}

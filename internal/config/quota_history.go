package config

// QuotaHistoryConfig configures the background recorder that samples the quota
// of subscription credentials (t3code fork addition).
type QuotaHistoryConfig struct {
	// Enabled turns the recorder on. Default false: nothing is polled or stored.
	Enabled bool `yaml:"enabled" json:"enabled"`
	// Providers restricts polling to these provider IDs. Empty enables every supported provider.
	Providers []string `yaml:"providers,omitempty" json:"providers,omitempty"`
	// Interval is the poll interval, e.g. "10m". Values below 5m are clamped.
	Interval string `yaml:"interval,omitempty" json:"interval,omitempty"`
	// Retention bounds how long samples are kept, e.g. "35d" or "840h".
	Retention string `yaml:"retention,omitempty" json:"retention,omitempty"`
	// Path is the bbolt database file. Empty means quota-history.db next to the config file.
	Path string `yaml:"path,omitempty" json:"path,omitempty"`
}

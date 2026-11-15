package config

const (
	// DefaultPanelGitHubRepository is empty: the management panel compiled into the
	// binary is served unless panel-github-repository is set explicitly.
	DefaultPanelGitHubRepository = ""
	DefaultPprofAddr             = "127.0.0.1:8316"
	// DefaultAuthDir is the auth directory for new installs when auth-dir is not set.
	DefaultAuthDir = "~/.t3code-proxy"
	// LegacyAuthDir is the auth directory used by earlier releases. It is still used
	// when it exists and DefaultAuthDir does not; see EffectiveDefaultAuthDir.
	LegacyAuthDir               = "~/.cli-proxy-api"
	DefaultDiscoveryServiceType = "_ai-gateway._tcp"
	DefaultKVStorePath          = "kv.db"
)

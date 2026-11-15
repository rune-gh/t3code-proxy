package handlers

import (
	"github.com/rune-oai/t3code-proxy/internal/runtime/executor/helps"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/usage"
)

func parsePluginExecutorResponseUsage(protocol string, payload []byte) usage.Detail {
	return helps.ParsePluginExecutorResponseUsage(protocol, payload)
}

func observePluginExecutorStreamUsage(protocol string, payload []byte, buffer *helps.StreamUsageBuffer) {
	helps.ObservePluginExecutorStreamUsage(protocol, payload, buffer)
}

func observePluginExecutorStreamTTFT(protocol string, reporter *helps.UsageReporter, payload []byte) {
	helps.ObservePluginExecutorStreamTTFT(protocol, reporter, payload)
}

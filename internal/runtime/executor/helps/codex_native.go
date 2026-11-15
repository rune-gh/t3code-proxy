package helps

import (
	"strings"

	"github.com/rune-oai/t3code-proxy/internal/util"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	sdktranslator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

// IsNativeCodexRequest checks the client dialect for use inside Codex executors.
func IsNativeCodexRequest(body []byte, opts cliproxyexecutor.Options) bool {
	for _, format := range []sdktranslator.Format{opts.SourceFormat, cliproxyexecutor.ResponseFormatOrSource(opts)} {
		name := strings.TrimSpace(format.String())
		if !strings.EqualFold(name, sdktranslator.FormatCodex.String()) && !strings.EqualFold(name, sdktranslator.FormatOpenAIResponse.String()) {
			return false
		}
	}
	return util.IsCodexResponsesLiteRequest(body, opts.Headers)
}

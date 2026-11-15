package claude

import (
	. "github.com/rune-oai/t3code-proxy/internal/constant"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/translator/translator"
)

func init() {
	translator.Register(
		Claude,
		Interactions,
		ConvertClaudeRequestToInteractions,
		interfaces.TranslateResponse{
			Stream:    ConvertInteractionsResponseToClaude,
			NonStream: ConvertInteractionsResponseToClaudeNonStream,
		},
	)
}

package gemini

import (
	. "github.com/rune-oai/t3code-proxy/internal/constant"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/translator/translator"
)

func init() {
	translator.Register(
		Gemini,
		Codex,
		ConvertGeminiRequestToCodex,
		interfaces.TranslateResponse{
			Stream:     ConvertCodexResponseToGemini,
			NonStream:  ConvertCodexResponseToGeminiNonStream,
			TokenCount: GeminiTokenCount,
		},
	)
}

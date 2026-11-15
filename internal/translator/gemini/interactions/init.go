package interactions

import (
	. "github.com/rune-oai/t3code-proxy/internal/constant"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/translator/translator"
)

func init() {
	translator.Register(
		Interactions,
		Interactions,
		ConvertInteractionsRequestToInteractions,
		interfaces.TranslateResponse{
			Stream:    ConvertInteractionsResponsePassthrough,
			NonStream: ConvertInteractionsResponsePassthroughNonStream,
		},
	)
	translator.Register(
		Interactions,
		Gemini,
		ConvertInteractionsRequestToGemini,
		interfaces.TranslateResponse{
			Stream:    ConvertGeminiResponseToInteractions,
			NonStream: ConvertGeminiResponseToInteractionsNonStream,
		},
	)
	translator.Register(
		Gemini,
		Interactions,
		ConvertGeminiRequestToInteractions,
		interfaces.TranslateResponse{
			Stream:    ConvertInteractionsResponseToGemini,
			NonStream: ConvertInteractionsResponseToGeminiNonStream,
		},
	)
}

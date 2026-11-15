package chat_completions

import (
	. "github.com/rune-oai/t3code-proxy/internal/constant"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/translator/translator"
)

func init() {
	translator.Register(
		OpenAI,
		Interactions,
		ConvertOpenAIRequestToInteractions,
		interfaces.TranslateResponse{
			Stream:    ConvertInteractionsResponseToOpenAI,
			NonStream: ConvertInteractionsResponseToOpenAINonStream,
		},
	)
	translator.Register(
		Interactions,
		OpenAI,
		ConvertInteractionsRequestToOpenAI,
		interfaces.TranslateResponse{
			Stream:    ConvertOpenAIResponseToInteractions,
			NonStream: ConvertOpenAIResponseToInteractionsNonStream,
		},
	)
}

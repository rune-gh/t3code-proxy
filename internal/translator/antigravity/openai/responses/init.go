package responses

import (
	. "github.com/rune-oai/t3code-proxy/internal/constant"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/translator/translator"
	sdktranslator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

func init() {
	translator.Register(
		OpenaiResponse,
		Antigravity,
		nil,
		interfaces.TranslateResponse{
			Stream:    ConvertAntigravityResponseToOpenAIResponses,
			NonStream: ConvertAntigravityResponseToOpenAIResponsesNonStream,
		},
	)
	sdktranslator.RegisterRequestEnvelope(
		sdktranslator.FormatOpenAIResponse,
		sdktranslator.FormatAntigravity,
		ConvertOpenAIResponsesRequestEnvelopeToAntigravity,
	)
}

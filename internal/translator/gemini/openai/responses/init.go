package responses

import (
	. "github.com/rune-oai/t3code-proxy/internal/constant"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/translator/translator"
)

func init() {
	translator.Register(
		OpenaiResponse,
		Gemini,
		ConvertOpenAIResponsesRequestToGemini,
		interfaces.TranslateResponse{
			Stream:    ConvertGeminiResponseToOpenAIResponses,
			NonStream: ConvertGeminiResponseToOpenAIResponsesNonStream,
		},
	)
}

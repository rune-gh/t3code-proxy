package claude

import (
	"context"

	. "github.com/rune-oai/t3code-proxy/internal/constant"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/translator/translator"
	sdktranslator "github.com/rune-oai/t3code-proxy/sdk/translator"
)

func init() {
	translator.Register(
		Claude,
		Antigravity,
		nil,
		interfaces.TranslateResponse{
			Stream:     ConvertAntigravityResponseToClaude,
			NonStream:  ConvertAntigravityResponseToClaudeNonStream,
			TokenCount: ClaudeTokenCount,
		},
	)
	sdktranslator.RegisterRequestEnvelope(sdktranslator.FormatClaude, sdktranslator.FormatAntigravity, convertClaudeRequestEnvelopeToAntigravity)
}

func convertClaudeRequestEnvelopeToAntigravity(_ context.Context, req sdktranslator.RequestEnvelope) sdktranslator.RequestEnvelope {
	var webSearch *bool
	if req.ModelInfo != nil && req.ModelInfo.NativeCapabilities != nil {
		webSearch = req.ModelInfo.NativeCapabilities.WebSearch
	}
	req.Body, req.Err = convertClaudeRequestToAntigravityWithWebSearch(req.Model, req.Body, req.Stream, webSearch)
	return req
}

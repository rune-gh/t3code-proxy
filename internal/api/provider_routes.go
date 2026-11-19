package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/util"
	"github.com/rune-oai/t3code-proxy/sdk/api/handlers"
	"github.com/rune-oai/t3code-proxy/sdk/api/handlers/claude"
	"github.com/rune-oai/t3code-proxy/sdk/api/handlers/gemini"
	"github.com/rune-oai/t3code-proxy/sdk/api/handlers/openai"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func (s *Server) setupProviderRoutes(openaiHandler *openai.OpenAIAPIHandler, claudeHandler *claude.ClaudeCodeAPIHandler, responsesHandler *openai.OpenAIResponsesAPIHandler, geminiHandler *gemini.GeminiAPIHandler) {
	group := s.engine.Group("/provider/:provider", AuthMiddleware(s.accessManager))
	group.Use(func(c *gin.Context) {
		provider := strings.ToLower(strings.TrimSpace(c.Param("provider")))
		modelRegistry := registry.GetGlobalRegistry()
		if !modelRegistry.HasProvider(provider) {
			provider = util.OpenAICompatibleProviderKey(provider)
		}
		if !modelRegistry.HasProvider(provider) {
			message := fmt.Sprintf("unknown provider %q", c.Param("provider"))
			errMsg := &interfaces.ErrorMessage{StatusCode: http.StatusNotFound, Error: errors.New(message)}
			switch {
			case strings.Contains(c.FullPath(), "/v1beta/"):
				c.JSON(http.StatusNotFound, gin.H{"error": gin.H{"code": http.StatusNotFound, "message": message, "status": "NOT_FOUND"}})
			case strings.Contains(c.FullPath(), "/messages") || (strings.Contains(c.FullPath(), "/v1/models") && isAnthropicModelsRequest(c)):
				claudeHandler.WriteErrorResponse(c, errMsg)
			default:
				s.handlers.WriteErrorResponse(c, errMsg)
			}
			c.Abort()
			return
		}
		c.Request = c.Request.WithContext(auth.WithProviderScope(c.Request.Context(), provider))
		c.Next()
	})
	group.GET("/v1/models", s.unifiedModelsHandler(openaiHandler, claudeHandler))
	group.GET("/v1/models/*model", func(c *gin.Context) {
		c.Set(handlers.ModelDetailIDContextKey, strings.TrimPrefix(c.Param("model"), "/"))
		s.unifiedModelsHandler(openaiHandler, claudeHandler)(c)
	})
	group.POST("/v1/chat/completions", openaiHandler.ChatCompletions)
	group.POST("/v1/completions", openaiHandler.Completions)
	// The Responses WebSocket, compaction and search make /provider/codex/v1 a complete Codex
	// base URL, so Codex can read its model list live from the hub instead of a pinned file.
	group.GET("/v1/responses", responsesHandler.ResponsesWebsocket)
	group.POST("/v1/responses", responsesHandler.Responses)
	group.POST("/v1/responses/compact", responsesHandler.Compact)
	group.POST("/v1/alpha/search", s.codexAlphaSearch)
	group.POST("/v1/messages", claudeHandler.ClaudeMessages)
	group.POST("/v1/messages/count_tokens", claudeHandler.ClaudeCountTokens)
	group.GET("/v1beta/models", s.geminiModelsHandler(geminiHandler))
	group.GET("/v1beta/models/*action", s.geminiGetHandler(geminiHandler))
	group.POST("/v1beta/models/*action", geminiHandler.GeminiHandler)
}

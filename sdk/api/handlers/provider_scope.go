package handlers

import (
	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

// ModelsForRequest returns the catalog in the requested format, honoring a provider scope.
func (h *BaseAPIHandler) ModelsForRequest(c *gin.Context, handlerType string) []map[string]any {
	r := registry.GetGlobalRegistry()
	if c != nil && c.Request != nil {
		if scope := coreauth.ProviderScopeFromContext(c.Request.Context()); scope != "" {
			return r.GetAvailableModelsForProvider(scope, handlerType)
		}
	}
	return r.GetAvailableModels(handlerType)
}

package handlers

import (
	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/registry"
	"github.com/rune-oai/t3code-proxy/internal/runtime/executor/helps"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

// ModelsForRequest returns the catalog in the requested format, honoring a provider scope.
func (h *BaseAPIHandler) ModelsForRequest(c *gin.Context, handlerType string) []map[string]any {
	r := registry.GetGlobalRegistry()
	if c == nil || c.Request == nil {
		return r.GetAvailableModels(handlerType)
	}
	ctx := c.Request.Context()
	client, _ := coreauth.SubscriptionClientFromContext(ctx)
	if handlerType == "claude" && claudeCodeCatalogRequest(c, h) {
		client = registry.ReservedForClaudeCode
	}
	return r.ClientModels(coreauth.ProviderScopeFromContext(ctx), client, handlerType)
}

// claudeCodeCatalogRequest reports whether the model list goes to Claude Code, which
// may list Claude subscription models: a native Claude Code client, or Claude Code's
// gateway model discovery, which T3 Code's Claude model picker is built from.
func claudeCodeCatalogRequest(c *gin.Context, h *BaseAPIHandler) bool {
	userAgent := c.Request.UserAgent()
	return helps.IsClaudeCodeModelDiscoveryUserAgent(userAgent) ||
		helps.NativeClaudeCodeClient(userAgent, h.AuthManager.RuntimeConfigSnapshot())
}

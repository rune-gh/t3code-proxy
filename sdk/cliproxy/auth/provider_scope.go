package auth

import (
	"context"
	"strings"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

type providerScopeContextKey struct{}
type excludeClaudeSubscriptionsKey struct{}

// WithClaudeSubscriptionAccess carries the incoming client classification through credential selection.
func WithClaudeSubscriptionAccess(ctx context.Context, allowed bool) context.Context {
	return context.WithValue(ctx, excludeClaudeSubscriptionsKey{}, !allowed)
}

func ClaudeSubscriptionsExcluded(ctx context.Context) bool {
	if ctx == nil {
		return false
	}
	excluded, _ := ctx.Value(excludeClaudeSubscriptionsKey{}).(bool)
	return excluded
}

// WithProviderScope restricts a client request to a registry provider key.
func WithProviderScope(ctx context.Context, provider string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, providerScopeContextKey{}, strings.ToLower(strings.TrimSpace(provider)))
}

// ProviderScopeFromContext returns the provider requested by a scoped endpoint.
func ProviderScopeFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	provider, _ := ctx.Value(providerScopeContextKey{}).(string)
	return provider
}

func scopedProviders(ctx context.Context, providers []string) []string {
	scope := ProviderScopeFromContext(ctx)
	if scope == "" {
		return providers
	}
	for _, provider := range providers {
		if strings.EqualFold(provider, scope) {
			return []string{scope}
		}
	}
	return nil
}

func providerAffinityNamespace(provider string, metadata map[string]any) string {
	if provider == "" {
		return ""
	}
	if scope := sessionMetadataString(metadata, cliproxyexecutor.ProviderScopeMetadataKey); scope != "" {
		return "provider/" + scope + "/" + provider
	}
	return provider
}

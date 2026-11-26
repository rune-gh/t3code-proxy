package auth

import (
	"context"
	"strings"

	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

type providerScopeContextKey struct{}
type subscriptionClientKey struct{}

// WithSubscriptionClient records which client sent a request, so credential selection
// only uses subscriptions reserved for it (see Auth.ReservedClient). client is a
// registry.ReservedFor* value, or "" for a third-party client that may use no reserved
// subscription. A context without it, such as an internal request, is not restricted.
func WithSubscriptionClient(ctx context.Context, client string) context.Context {
	return context.WithValue(ctx, subscriptionClientKey{}, client)
}

// SubscriptionClientFromContext returns the client recorded by WithSubscriptionClient
// and whether one was recorded.
func SubscriptionClientFromContext(ctx context.Context) (client string, restricted bool) {
	if ctx == nil {
		return "", false
	}
	client, restricted = ctx.Value(subscriptionClientKey{}).(string)
	return client, restricted
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

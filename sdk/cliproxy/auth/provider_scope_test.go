package auth

import (
	"context"
	"strings"
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/executionregistry"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
)

func TestProviderScopeAffinityNamespaces(t *testing.T) {
	metadata := map[string]any{cliproxyexecutor.CallerScopeMetadataKey: "caller"}
	unscoped := lcpAffinityNamespace("mixed", "model", metadata)
	metadata[cliproxyexecutor.ProviderScopeMetadataKey] = "antigravity"
	antigravity := lcpAffinityNamespace("mixed", "model", metadata)
	metadata[cliproxyexecutor.ProviderScopeMetadataKey] = "claude"
	claude := lcpAffinityNamespace("mixed", "model", metadata)
	if unscoped == antigravity || antigravity == claude || unscoped == claude {
		t.Fatalf("content affinity namespaces overlap: %q %q %q", unscoped, antigravity, claude)
	}
}

func TestProviderScopeRejectsMismatchedHomeDispatch(t *testing.T) {
	manager := NewManager(nil, nil, nil)
	manager.SetConfig(&config.Config{Home: config.HomeConfig{Enabled: true}})
	manager.PublishHomeDispatch(homeExecutionDispatcher{}, executionregistry.New(), 1)
	manager.RegisterExecutor(&homeExecutionExecutor{})
	ctx := WithProviderScope(context.Background(), "antigravity")
	selection, errSelection := manager.pickHomeDispatchSelection(ctx, "model", cliproxyexecutor.Options{})
	if selection != nil || errSelection == nil || !strings.Contains(errSelection.Error(), "outside the provider scope") {
		t.Fatalf("selection=%v error=%v", selection, errSelection)
	}
}

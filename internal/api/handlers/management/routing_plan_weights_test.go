package management

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/MoeForge/moego/ojson"
	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/config"
	coreauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
)

func TestRoutingPlanWeightsEndpoint(t *testing.T) {
	gin.SetMode(gin.TestMode)
	path := filepath.Join(t.TempDir(), "config.yaml")
	if errWrite := os.WriteFile(path, []byte("routing:\n  strategy: soonest-reset-first\n"), 0o600); errWrite != nil {
		t.Fatalf("write: %v", errWrite)
	}
	cfg, errLoad := config.LoadConfig(path)
	if errLoad != nil {
		t.Fatalf("load: %v", errLoad)
	}
	h := &Handler{cfg: cfg, configFilePath: path}
	router := gin.New()
	router.GET("/v8/management/routing/plan-weights", h.GetRoutingPlanWeights)
	router.PUT("/v8/management/config/*path", h.ConfigV8)
	router.PATCH("/v8/management/config/*path", h.ConfigV8)

	request := func(method, url, body string, wantStatus int) []byte {
		t.Helper()
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(method, url, strings.NewReader(body)))
		if recorder.Code != wantStatus {
			t.Fatalf("%s %s: status=%d body=%s", method, url, recorder.Code, recorder.Body.String())
		}
		return recorder.Body.Bytes()
	}
	type tables struct {
		Defaults   map[string]map[string]float64 `json:"defaults"`
		Configured map[string]map[string]float64 `json:"configured"`
		Effective  map[string]map[string]float64 `json:"effective"`
	}
	get := func() tables {
		t.Helper()
		raw := request(http.MethodGet, "/v8/management/routing/plan-weights", "", http.StatusOK)
		root := ojson.ParseBytes(raw)
		if !root.IsObject() || len(root.Map()) != 3 {
			t.Fatalf("response %s: want exactly defaults, configured, effective", raw)
		}
		table := func(name string) map[string]map[string]float64 {
			out := make(map[string]map[string]float64)
			for provider, plans := range root.Get(name).Map() {
				out[provider] = make(map[string]float64)
				for plan, weight := range plans.Map() {
					out[provider][plan] = weight.Float()
				}
			}
			return out
		}
		if !root.Get("defaults").IsObject() || !root.Get("configured").IsObject() || !root.Get("effective").IsObject() {
			t.Fatalf("response %s: missing a weight table", raw)
		}
		out := tables{Defaults: table("defaults"), Configured: table("configured"), Effective: table("effective")}
		return out
	}

	initial := get()
	if !reflect.DeepEqual(initial.Defaults, coreauth.DefaultPlanWeights()) || initial.Defaults["claude"]["max_20x"] != 20 {
		t.Fatalf("defaults = %v", initial.Defaults)
	}
	if initial.Configured == nil || len(initial.Configured) != 0 {
		t.Fatalf("configured = %v, want {}", initial.Configured)
	}
	if !reflect.DeepEqual(initial.Effective, initial.Defaults) {
		t.Fatalf("effective = %v, want defaults", initial.Effective)
	}

	// Writes go through the generic config endpoint.
	request(http.MethodPut, "/v8/management/config/routing/plan-weights", `{"codex":{"Pro":10},"kimi":{"premium":3}}`, http.StatusOK)
	updated := get()
	if updated.Configured["codex"]["pro"] != 10 || updated.Configured["kimi"]["premium"] != 3 {
		t.Fatalf("configured = %v", updated.Configured)
	}
	if updated.Effective["codex"]["pro"] != 10 || updated.Effective["codex"]["plus"] != 1 || updated.Effective["kimi"]["premium"] != 3 {
		t.Fatalf("effective = %v", updated.Effective)
	}
	if updated.Defaults["codex"]["pro"] != 20 {
		t.Fatalf("defaults changed: %v", updated.Defaults)
	}
	request(http.MethodPut, "/v8/management/config/routing/plan-headroom-reserve", `5`, http.StatusOK)
	if got := h.cfg.Routing.EffectivePlanHeadroomReserve(); got != 5 {
		t.Fatalf("reserve = %v, want 5", got)
	}

	// Invalid values are rejected and leave the file unchanged.
	before, _ := os.ReadFile(path)
	request(http.MethodPut, "/v8/management/config/routing/plan-weights", `{"codex":{"pro":0}}`, http.StatusUnprocessableEntity)
	request(http.MethodPut, "/v8/management/config/routing/plan-headroom-reserve", `-1`, http.StatusUnprocessableEntity)
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("rejected write changed the config file")
	}
}

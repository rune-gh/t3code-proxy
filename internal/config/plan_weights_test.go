package config

import (
	"math"
	"strings"
	"testing"
)

func TestValidatePlanRouting(t *testing.T) {
	tests := []struct {
		name    string
		routing RoutingConfig
		wantErr string
	}{
		{name: "empty"},
		{name: "valid", routing: RoutingConfig{
			PlanWeights:         map[string]map[string]float64{"claude": {"max_20x": 20, "pro": 1}, "codex": {"pro": 0.5}},
			PlanHeadroomReserve: new(0.0),
		}},
		{name: "zero weight", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"codex": {"pro": 0}}}, wantErr: "weight must be greater than 0"},
		{name: "negative weight", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"codex": {"pro": -1}}}, wantErr: "weight must be greater than 0"},
		{name: "too large", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"codex": {"pro": MaxPlanWeight + 1}}}, wantErr: "at most"},
		{name: "infinite", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"codex": {"pro": math.Inf(1)}}}, wantErr: "weight must be"},
		{name: "nan", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"codex": {"pro": math.NaN()}}}, wantErr: "weight must be"},
		{name: "empty plan", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"codex": {" ": 2}}}, wantErr: "plan name must not be empty"},
		{name: "empty provider", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"": {"pro": 2}}}, wantErr: "provider name must not be empty"},
		{name: "duplicate plan", routing: RoutingConfig{PlanWeights: map[string]map[string]float64{"claude": {"Max 20x": 20, "max-20x": 15}}}, wantErr: "same plan"},
		{name: "negative reserve", routing: RoutingConfig{PlanHeadroomReserve: new(-1.0)}, wantErr: "plan-headroom-reserve"},
		{name: "reserve too large", routing: RoutingConfig{PlanHeadroomReserve: new(MaxPlanHeadroomReserve + 1)}, wantErr: "plan-headroom-reserve"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := (&Config{Routing: tt.routing}).ValidatePlanRouting()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("ValidatePlanRouting() = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("ValidatePlanRouting() = %v, want error containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestParsePlanRouting(t *testing.T) {
	cfg, err := ParseConfigBytes([]byte("routing:\n  strategy: soonest-reset-first\n  plan-weights:\n    codex:\n      pro: 8\n  plan-headroom-reserve: 5\n"))
	if err != nil {
		t.Fatalf("ParseConfigBytes() = %v", err)
	}
	if cfg.Routing.PlanWeights["codex"]["pro"] != 8 || cfg.Routing.EffectivePlanHeadroomReserve() != 5 {
		t.Fatalf("routing = %+v", cfg.Routing)
	}
	if cfg, err = ParseConfigBytes([]byte("routing:\n  strategy: soonest-reset-first\n")); err != nil || cfg.Routing.EffectivePlanHeadroomReserve() != DefaultPlanHeadroomReserve {
		t.Fatalf("default reserve: %v, %v", cfg, err)
	}
	if _, err = ParseConfigBytes([]byte("routing:\n  plan-weights:\n    codex:\n      pro: 0\n")); err == nil {
		t.Fatal("ParseConfigBytes accepted a zero plan weight")
	}
}

func TestNormalizePlanKey(t *testing.T) {
	for raw, want := range map[string]string{" Max 20x ": "max_20x", "max-5x": "max_5x", "PRO": "pro", "a  -b": "a_b", "_": ""} {
		if got := NormalizePlanKey(raw); got != want {
			t.Fatalf("NormalizePlanKey(%q) = %q, want %q", raw, got, want)
		}
	}
}

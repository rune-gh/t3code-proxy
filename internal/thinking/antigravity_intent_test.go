package thinking_test

import (
	"testing"

	"github.com/rune-oai/t3code-proxy/internal/thinking"
)

func TestRequestedAntigravityThinkingLevel(t *testing.T) {
	cases := []struct {
		name  string
		from  string
		model string
		body  string
		want  thinking.ThinkingLevel
	}{
		{
			name:  "explicit suffix overrides body",
			from:  "claude",
			model: "claude-opus-5-5-high(low)",
			body:  `{"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`,
			want:  thinking.LevelLow,
		},
		{
			name:  "numeric suffix maps to level",
			from:  "gemini",
			model: "gemini-4-carbon-high(1024)",
			body:  `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`,
			want:  thinking.LevelLow,
		},
		{
			name:  "gemini thinking_config snake_case",
			from:  "gemini",
			model: "claude-opus-5-5-high",
			body:  `{"generationConfig":{"thinking_config":{"thinking_level":"MEDIUM"}}}`,
			want:  thinking.LevelMedium,
		},
		{
			name:  "antigravity envelope thinkingConfig",
			from:  "antigravity",
			model: "gemini-4-carbon-high",
			body:  `{"request":{"generationConfig":{"thinkingConfig":{"thinkingLevel":"LOW"}}}}`,
			want:  thinking.LevelLow,
		},
		{
			name:  "claude output_config effort",
			from:  "claude",
			model: "claude-opus-5-5-high",
			body:  `{"thinking":{"type":"adaptive"},"output_config":{"effort":"medium"}}`,
			want:  thinking.LevelMedium,
		},
		{
			name:  "claude adaptive without effort returns empty",
			from:  "claude",
			model: "claude-opus-5-5-high",
			body:  `{"thinking":{"type":"adaptive"}}`,
			want:  "",
		},
		{
			name:  "openai nested generation_config overrides reasoning_effort",
			from:  "openai",
			model: "gemini-4-neon-xhigh",
			body:  `{"reasoning_effort":"xhigh","generation_config":{"thinking_config":{"thinking_level":"low"}}}`,
			want:  thinking.LevelLow,
		},
		{
			name:  "openai responses reasoning effort",
			from:  "openai-response",
			model: "claude-sonnet-5-5-high",
			body:  `{"reasoning":{"effort":"low"},"input":"hi"}`,
			want:  thinking.LevelLow,
		},
		{
			name:  "interactions reasoning overrides generation_config",
			from:  "interactions",
			model: "gemini-4-neon-xhigh",
			body:  `{"reasoning":{"effort":"xhigh"},"generation_config":{"thinking_level":"low"},"input":"hi"}`,
			want:  thinking.LevelXHigh,
		},
		{
			name:  "no thinking intent returns empty",
			from:  "gemini",
			model: "claude-opus-5-5-high",
			body:  `{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}`,
			want:  "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := thinking.RequestedAntigravityThinkingLevel([]byte(tc.body), tc.from, tc.model)
			if got != tc.want {
				t.Fatalf("RequestedAntigravityThinkingLevel(%q, %q) = %q, want %q", tc.from, tc.model, got, tc.want)
			}
		})
	}
}

package helps

import (
	"testing"

	"github.com/MoeForge/moego/ojson"
)

func TestNormalizeOpenAIContentPartsSplitsMistralThinking(t *testing.T) {
	for name, tc := range map[string]struct {
		payload, field, wantContent, wantReasoning string
	}{
		"stream thinking delta": {
			payload:       `{"choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"The user"}],"closed":true}]}}]}`,
			field:         "delta",
			wantReasoning: "The user",
		},
		"stream text delta": {
			payload:     `{"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"ok"}]}}]}`,
			field:       "delta",
			wantContent: "ok",
		},
		"message with both": {
			payload:       `{"choices":[{"index":0,"message":{"role":"assistant","reasoning_content":"a ","content":[{"type":"thinking","thinking":"b"},{"type":"text","text":"ok"}]}}]}`,
			field:         "message",
			wantContent:   "ok",
			wantReasoning: "a b",
		},
	} {
		t.Run(name, func(t *testing.T) {
			out := NormalizeOpenAIContentParts([]byte(tc.payload))
			content := ojson.GetBytes(out, "choices.0."+tc.field+".content")
			if content.Type != ojson.String || content.String() != tc.wantContent {
				t.Fatalf("content = %s, want %q; out %s", content.Raw, tc.wantContent, out)
			}
			if got := ojson.GetBytes(out, "choices.0."+tc.field+".reasoning_content").String(); got != tc.wantReasoning {
				t.Fatalf("reasoning_content = %q, want %q; out %s", got, tc.wantReasoning, out)
			}
		})
	}
}

func TestNormalizeOpenAIContentPartsLeavesStringContentAlone(t *testing.T) {
	payload := `{"choices":[{"index":0,"delta":{"content":"ok"}}]}`
	if out := NormalizeOpenAIContentParts([]byte(payload)); string(out) != payload {
		t.Fatalf("out = %s", out)
	}
}

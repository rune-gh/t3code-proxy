package helps

import (
	"testing"

	"github.com/MoeForge/moego/ojson"
)

func TestIsMistralBaseURL(t *testing.T) {
	for baseURL, want := range map[string]bool{
		"https://api.mistral.ai/v1":         true,
		"https://API.Mistral.AI/v1/":        true,
		"https://codestral.mistral.ai/v1":   true,
		"https://mistral.ai":                true,
		"https://api.deepseek.com/v1":       false,
		"https://notmistral.ai/v1":          false,
		"https://mistral.ai.example.com/v1": false,
		"http://127.0.0.1:8317/v1":          false,
		"":                                  false,
		"::not a url":                       false,
	} {
		if got := IsMistralBaseURL(baseURL); got != want {
			t.Errorf("IsMistralBaseURL(%q) = %v, want %v", baseURL, got, want)
		}
	}
}

func TestStripMistralEchoedReasoningDoc(t *testing.T) {
	doc := ojson.NewDocString(`{"model":"zai-glm-5-3","messages":[` +
		`{"role":"user","content":"hi"},` +
		`{"role":"assistant","content":"hello","reasoning_content":"r1","reasoning":"r2","reasoning_details":[{"type":"text","text":"r3"}],"reasoning_text":"r4","reasoning_opaque":"r5","tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{}"}}]},` +
		`{"role":"tool","tool_call_id":"call_1","content":"ok"},` +
		`{"role":"assistant","content":"done","reasoning_content":"r6"}]}`)

	if !StripMistralEchoedReasoningDoc(doc) {
		t.Fatal("expected the document to change")
	}
	out := doc.String()
	for _, idx := range []string{"1", "3"} {
		msg := ojson.GetBytes([]byte(out), "messages."+idx)
		for _, key := range mistralEchoedReasoningKeys {
			if msg.Get(key).Exists() {
				t.Fatalf("messages.%s.%s survived: %s", idx, key, out)
			}
		}
	}
	if got := ojson.GetBytes([]byte(out), "messages.1.content").String(); got != "hello" {
		t.Fatalf("content = %q, want hello: %s", got, out)
	}
	if got := ojson.GetBytes([]byte(out), "messages.1.tool_calls.0.id").String(); got != "call_1" {
		t.Fatalf("tool_calls lost: %s", out)
	}
	if got := ojson.GetBytes([]byte(out), "messages.2.tool_call_id").String(); got != "call_1" {
		t.Fatalf("tool message changed: %s", out)
	}

	if StripMistralEchoedReasoningDoc(doc) {
		t.Fatal("second pass should find nothing to strip")
	}
	if StripMistralEchoedReasoningDoc(ojson.NewDocString(`{"input":"x"}`)) {
		t.Fatal("a document without messages should not change")
	}
	if StripMistralEchoedReasoningDoc(nil) {
		t.Fatal("nil document should not change")
	}
}

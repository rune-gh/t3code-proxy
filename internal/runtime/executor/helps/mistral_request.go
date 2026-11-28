package helps

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/MoeForge/moego/ojson"
)

// mistralEchoedReasoningKeys are the reasoning fields OpenAI-compatible
// clients (OpenCode's AI SDK among them) echo back on earlier assistant turns.
// Mistral's chat completions API forbids unknown message keys and answers any
// of them with 422 extra_forbidden, so a multi-turn conversation with a
// reasoning model (GLM, DeepSeek, Magistral) fails on its second turn.
var mistralEchoedReasoningKeys = []string{
	"reasoning_content",
	"reasoning",
	"reasoning_details",
	"reasoning_text",
	"reasoning_opaque",
}

// IsMistralBaseURL reports whether baseURL points at Mistral's API.
func IsMistralBaseURL(baseURL string) bool {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "mistral.ai" || strings.HasSuffix(host, ".mistral.ai")
}

// StripMistralEchoedReasoningDoc removes echoed reasoning fields from every
// chat message. It reports whether the document changed.
func StripMistralEchoedReasoningDoc(doc *ojson.Doc) bool {
	if doc == nil {
		return false
	}
	messages := doc.Get("messages")
	if !messages.IsArray() {
		return false
	}
	modified := false
	for idx, msg := range messages.Array() {
		for _, key := range mistralEchoedReasoningKeys {
			if !msg.Get(key).Exists() {
				continue
			}
			if doc.Delete(fmt.Sprintf("messages.%d.%s", idx, key)) == nil {
				modified = true
			}
		}
	}
	return modified
}

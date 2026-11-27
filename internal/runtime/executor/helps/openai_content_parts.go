package helps

import (
	"bytes"
	"strconv"
	"strings"

	"github.com/MoeForge/moego/ojson"
)

// Mistral's chat completions API answers reasoning models (Magistral, and the
// GLM models it hosts) with content as an array of typed parts instead of a
// string:
//
//	"content": [{"type": "thinking", "thinking": [{"type": "text", "text": "..."}]},
//	            {"type": "text", "text": "..."}]
//
// OpenAI chat-completions clients such as the AI SDK used by OpenCode reject
// that shape ("Invalid ... stream event"). NormalizeOpenAIContentParts turns it
// into the usual form: text parts become the content string and thinking parts
// become reasoning_content, which the response translators already understand.

var contentArrayMarker = []byte(`"content":[`)

// NormalizeOpenAIContentParts rewrites array-valued choices[].delta.content and
// choices[].message.content into strings. Payloads without array content are
// returned unchanged.
func NormalizeOpenAIContentParts(payload []byte) []byte {
	if !bytes.Contains(payload, contentArrayMarker) && !bytes.Contains(payload, []byte(`"content": [`)) {
		return payload
	}
	choices := ojson.GetBytes(payload, "choices")
	if !choices.IsArray() {
		return payload
	}
	var doc *ojson.Doc
	for i, choice := range choices.Array() {
		for _, field := range []string{"delta", "message"} {
			content := choice.Get(field + ".content")
			if !content.IsArray() {
				continue
			}
			text, reasoning := splitOpenAIContentParts(content)
			if doc == nil {
				doc = ojson.NewDoc(payload)
			}
			base := "choices." + strconv.Itoa(i) + "." + field
			if err := doc.Set(base+".content", text); err != nil {
				return payload
			}
			if reasoning == "" {
				continue
			}
			if existing := choice.Get(field + ".reasoning_content"); existing.Type == ojson.String {
				reasoning = existing.String() + reasoning
			}
			if err := doc.Set(base+".reasoning_content", reasoning); err != nil {
				return payload
			}
		}
	}
	if doc == nil {
		return payload
	}
	return doc.Bytes()
}

func splitOpenAIContentParts(content ojson.Result) (text, reasoning string) {
	var textOut, reasoningOut strings.Builder
	for _, part := range content.Array() {
		switch part.Get("type").String() {
		case "text":
			textOut.WriteString(part.Get("text").String())
		case "thinking", "reasoning":
			appendThinkingText(&reasoningOut, part.Get("thinking"))
		}
	}
	return textOut.String(), reasoningOut.String()
}

// appendThinkingText reads a thinking value that is either a string or an
// array of text parts.
func appendThinkingText(out *strings.Builder, thinking ojson.Result) {
	if thinking.Type == ojson.String {
		out.WriteString(thinking.String())
		return
	}
	for _, part := range thinking.Array() {
		if part.Type == ojson.String {
			out.WriteString(part.String())
			continue
		}
		out.WriteString(part.Get("text").String())
	}
}

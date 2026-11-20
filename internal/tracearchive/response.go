package tracearchive

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/MoeForge/moego/ojson"
)

// Executor hooks supply either a response body, scanner lines or WS messages.
// A terminal provider event is required before discarding the original frames.
func reconstruct(chunks [][]byte) ([]byte, bool) {
	if len(chunks) == 0 {
		return nil, false
	}
	if len(chunks) == 1 && ojson.ValidBytes(chunks[0]) {
		r := ojson.ParseBytes(chunks[0])
		typ := r.Get("type").String()
		if !strings.HasPrefix(typ, "response.") && !strings.HasPrefix(typ, "content_block_") && !strings.HasPrefix(typ, "message_") && !r.Get("choices.0.delta").Exists() && typ != "ping" && typ != "keepalive" && typ != "codex.response.metadata" && typ != "codex.rate_limits" {
			return safePayload(chunks[0]), true
		}
	}
	var s streamState
	for _, chunk := range chunks {
		if ojson.ValidBytes(chunk) {
			if !s.event(ojson.ParseBytes(safePayload(chunk))) {
				return nil, false
			}
			continue
		}
		for line := range bytes.SplitSeq(chunk, []byte("\n")) {
			line = bytes.TrimSpace(line)
			if len(line) == 0 || bytes.HasPrefix(line, []byte(":")) || bytes.HasPrefix(line, []byte("event:")) || bytes.HasPrefix(line, []byte("id:")) {
				continue
			}
			raw, ok := bytes.CutPrefix(line, []byte("data:"))
			if !ok {
				return nil, false
			}
			raw = bytes.TrimSpace(raw)
			if bytes.Equal(raw, []byte("[DONE]")) {
				s.chatEnd = true
				continue
			}
			if !ojson.ValidBytes(raw) || !s.event(ojson.ParseBytes(safePayload(raw))) {
				return nil, false
			}
		}
	}
	if s.doc == nil || !(s.complete || s.chat && s.chatEnd) || len(s.openBlocks) != 0 {
		return nil, false
	}
	for path, b := range s.text {
		if err := s.doc.Set(path, b.String()); err != nil {
			return nil, false
		}
	}
	for path, delta := range s.deltas {
		if final := s.doc.Get(path); final.Type != ojson.String || final.String() != delta.String() {
			return nil, false
		}
	}
	return s.doc.Bytes(), true
}

type streamState struct {
	text                    map[string]*strings.Builder
	doc                     *ojson.Doc
	complete, chat, chatEnd bool
	items                   map[int]string
	observedItems           map[int]bool
	deltas                  map[string]*strings.Builder
	openBlocks              map[int]*strings.Builder
}

func (s *streamState) event(r ojson.Result) bool {
	typ := r.Get("type").String()
	idx := r.Get("output_index")
	if strings.HasPrefix(typ, "response.") && (idx.Exists() || strings.HasSuffix(typ, ".delta")) {
		n := idx.Int()
		if n < 0 || n > 65535 {
			return false
		}
		if s.observedItems == nil {
			s.observedItems = make(map[int]bool)
		}
		s.observedItems[int(n)] = true
	}
	switch {
	case typ == "ping", typ == "keepalive", typ == "codex.response.metadata", typ == "response.metadata":
		return true
	case typ == "message_start":
		msg := r.Get("message")
		if !msg.IsObject() || s.doc != nil {
			return false
		}
		s.doc = ojson.NewDocString(msg.Raw)
		s.openBlocks = make(map[int]*strings.Builder)
	case typ == "content_block_start", typ == "content_block_delta", typ == "content_block_stop":
		if s.doc == nil || s.openBlocks == nil {
			return false
		}
		n := int(r.Get("index").Int())
		path := "content." + strconv.Itoa(n)
		if typ == "content_block_start" {
			b := r.Get("content_block")
			if !b.IsObject() || n != len(s.doc.Get("content").Array()) {
				return false
			}
			s.openBlocks[n] = new(strings.Builder)
			return s.doc.SetRaw(path, b.Raw) == nil
		}
		partial := s.openBlocks[n]
		if partial == nil {
			return false
		}
		if typ == "content_block_stop" {
			delete(s.openBlocks, n)
			if partial.Len() > 0 {
				if !ojson.Valid(partial.String()) {
					return false
				}
				return s.doc.SetRaw(path+".input", partial.String()) == nil
			}
			return true
		}
		delta := r.Get("delta")
		switch delta.Get("type").String() {
		case "input_json_delta":
			partial.WriteString(delta.Get("partial_json").String())
		case "citations_delta":
			return s.doc.SetRaw(path+".citations.-1", delta.Get("citation").Raw) == nil
		case "text_delta", "thinking_delta", "signature_delta":
			key := strings.TrimSuffix(delta.Get("type").String(), "_delta")
			return s.appendString(path+"."+key, delta.Get(key))
		default:
			return false
		}
	case typ == "message_delta":
		if s.doc == nil {
			return false
		}
		mergeFields(s.doc, "", r.Get("delta"))
		mergeFields(s.doc, "usage.", r.Get("usage"))
	case typ == "message_stop":
		s.complete = true
	case strings.HasPrefix(typ, "response.") && strings.HasSuffix(typ, ".delta"):
		// Drop raw frames only when the indexed final field includes the observed deltas.
		path := "output." + strconv.FormatInt(idx.Int(), 10) + "."
		switch typ {
		case "response.output_text.delta":
			path += "content." + strconv.FormatInt(r.Get("content_index").Int(), 10) + ".text"
		case "response.function_call_arguments.delta", "response.mcp_call_arguments.delta":
			path += "arguments"
		case "response.custom_tool_call_input.delta":
			path += "input"
		case "response.refusal.delta":
			path += "content." + strconv.FormatInt(r.Get("content_index").Int(), 10) + ".refusal"
		case "response.reasoning_text.delta":
			path += "content." + strconv.FormatInt(r.Get("content_index").Int(), 10) + ".text"
		case "response.reasoning_summary_text.delta":
			path += "summary." + strconv.FormatInt(r.Get("summary_index").Int(), 10) + ".text"
		default:
			return false
		}
		delta := r.Get("delta")
		if delta.Type != ojson.String {
			return false
		}
		if s.deltas == nil {
			s.deltas = make(map[string]*strings.Builder)
		}
		if s.deltas[path] == nil {
			s.deltas[path] = new(strings.Builder)
		}
		s.deltas[path].WriteString(delta.String())
	case typ == "response.output_item.done":
		item := r.Get("item")
		if !item.IsObject() {
			return false
		}
		if s.items == nil {
			s.items = make(map[int]string)
		}
		s.items[int(r.Get("output_index").Int())] = item.Raw
	case typ == "response.completed", typ == "response.done", typ == "response.incomplete", typ == "response.failed":
		resp := r.Get("response")
		if !resp.IsObject() || s.complete {
			return false
		}
		s.doc = ojson.NewDocString(resp.Raw)
		for i, item := range s.items {
			p := "output." + strconv.Itoa(i)
			final := s.doc.Get(p)
			if !final.IsObject() {
				_ = s.doc.SetRaw(p, item)
				continue
			}
			// Some compatible endpoints send a compact terminal item and
			// report its opaque replay fields only on output_item.done.
			prior := ojson.Parse(item)
			if id := prior.Get("id").String(); id != "" && final.Get("id").Exists() && final.Get("id").String() != id {
				return false
			}
			for k, v := range prior.Map() {
				key := ojson.Escape(k)
				if prev := final.Get(key); !prev.Exists() || prev.Type == ojson.Null || (prev.IsArray() && len(prev.Array()) == 0 && v.IsArray()) {
					_ = s.doc.SetRaw(p+"."+key, v.Raw)
				}
			}
		}
		for i := range s.observedItems {
			if !s.doc.Get("output." + strconv.Itoa(i)).IsObject() {
				return false
			}
		}
		s.complete = true
	case strings.HasPrefix(typ, "response.") || typ == "codex.rate_limits":
		// Responses terminal frames carry whole items, or reference indexed item.done frames.
	case r.Get("choices").IsArray():
		return s.chatChunk(r)
	default:
		return false
	}
	return true
}

func mergeFields(d *ojson.Doc, prefix string, r ojson.Result) {
	for key, value := range r.Map() {
		_ = d.SetRaw(prefix+ojson.Escape(key), value.Raw)
	}
}
func (s *streamState) appendString(path string, v ojson.Result) bool {
	if v.Type != ojson.String {
		return false
	}
	if s.text == nil {
		s.text = make(map[string]*strings.Builder)
	}
	b := s.text[path]
	if b == nil {
		b = new(strings.Builder)
		b.WriteString(s.doc.Get(path).String())
		s.text[path] = b
	}
	b.WriteString(v.String())
	return true
}
func (s *streamState) chatChunk(r ojson.Result) bool {
	if s.doc == nil {
		s.doc = object()
		s.chat = true
		_ = s.doc.SetRaw("choices", "[]")
	}
	if !s.chat {
		return false
	}
	for k, v := range r.Map() {
		if k != "choices" && k != "object" {
			if v.Type != ojson.Null || !s.doc.Get(ojson.Escape(k)).Exists() {
				_ = s.doc.SetRaw(ojson.Escape(k), v.Raw)
			}
		}
	}
	_ = s.doc.Set("object", "chat.completion")
	for _, choice := range r.Get("choices").Array() {
		i := choice.Get("index").Int()
		if i < 0 || i > 4096 {
			return false
		}
		p := fmt.Sprintf("choices.%d.", i)
		_ = s.doc.Set(p+"index", i)
		if v := choice.Get("finish_reason"); v.Exists() && v.Type != ojson.Null {
			_ = s.doc.SetRaw(p+"finish_reason", v.Raw)
		}
		if v := choice.Get("logprobs"); v.IsObject() {
			for k, arr := range v.Map() {
				for _, val := range arr.Array() {
					_ = s.doc.SetRaw(p+"logprobs."+ojson.Escape(k)+".-1", val.Raw)
				}
			}
		}
		for k, v := range choice.Get("delta").Map() {
			dest := p + "message." + ojson.Escape(k)
			switch k {
			case "role":
				_ = s.doc.SetRaw(dest, v.Raw)
			case "content", "refusal", "reasoning_content", "reasoning":
				if v.Type == ojson.Null {
					if !s.doc.Get(dest).Exists() {
						_ = s.doc.SetRaw(dest, "null")
					}
				} else if !s.appendString(dest, v) {
					return false
				}
			case "annotations":
				for _, a := range v.Array() {
					_ = s.doc.SetRaw(dest+".-1", a.Raw)
				}
			case "function_call":
				for f, str := range v.Map() {
					if !s.appendString(dest+"."+ojson.Escape(f), str) {
						return false
					}
				}
			case "tool_calls":
				for _, tc := range v.Array() {
					j := tc.Get("index").Int()
					if j < 0 || j > 4096 {
						return false
					}
					tp := fmt.Sprintf("%s.%d.", dest, j)
					for f, x := range tc.Map() {
						switch f {
						case "index":
						case "function":
							for key, str := range x.Map() {
								if !s.appendString(tp+"function."+ojson.Escape(key), str) {
									return false
								}
							}
						default:
							_ = s.doc.SetRaw(tp+ojson.Escape(f), x.Raw)
						}
					}
				}
			default:
				return false
			}
		}
	}
	return true
}

// Stable ordering for filenames, session groups and other small string maps.
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

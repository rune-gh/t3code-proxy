// Package tracearchive stores self-contained, versioned model-call segments.
package tracearchive

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"

	"github.com/MoeForge/moego/base64"
	"github.com/MoeForge/moego/ojson"
)

func digest(data []byte) string { return fmt.Sprintf("%x", sha256.Sum256(data)) }

// Bound recursive JSON walks independently of call size. This scan also works
// on individual SSE data lines without interpreting quoted prompt text.
func withinDepth(data []byte) bool {
	depth := 0
	quoted, escaped := false, false
	for _, c := range data {
		if quoted {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				quoted = false
			}
			continue
		}
		switch c {
		case '"':
			quoted = true
		case '{', '[':
			depth++
			if depth > 256 {
				return false
			}
		case '}', ']':
			if depth > 0 {
				depth--
			}
		}
	}
	return true
}

// Canonical form sorts object names, normalizes string escapes and retains number
// lexemes (especially integers outside the exact range of a float64).
func canonical(dst []byte, r ojson.Result) []byte {
	switch {
	case r.IsObject():
		keys := r.Map()
		names := make([]string, 0, len(keys))
		for key := range keys {
			names = append(names, key)
		}
		sort.Strings(names)
		dst = append(dst, '{')
		for i, key := range names {
			if i != 0 {
				dst = append(dst, ',')
			}
			dst = ojson.AppendJSONString(dst, key)
			dst = append(dst, ':')
			dst = canonical(dst, keys[key])
		}
		return append(dst, '}')
	case r.IsArray():
		dst = append(dst, '[')
		for i, item := range r.Array() {
			if i != 0 {
				dst = append(dst, ',')
			}
			dst = canonical(dst, item)
		}
		return append(dst, ']')
	case r.Type == ojson.String:
		return ojson.AppendJSONString(dst, r.String())
	default:
		return append(dst, r.Raw...)
	}
}

func object() *ojson.Doc           { return ojson.NewDocString("{}") }
func entry(kind string) *ojson.Doc { d := object(); _ = d.Set("type", kind); return d }

func credentialHeader(name string) bool {
	name = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(name), "_", "-"))
	return strings.Contains(name, "authorization") || strings.Contains(name, "api-key") || strings.Contains(name, "apikey") || strings.Contains(name, "cookie") || name == "token" || strings.HasSuffix(name, "-token")
}
func safePayload(data []byte) []byte {
	if !ojson.ValidBytes(data) {
		return data
	}
	d := ojson.NewDoc(data)
	// WS frames can carry transport metadata inside the JSON envelope. Treat
	// these containers as headers even if a provider uses unusual key casing.
	var walk func(ojson.Result, string, bool)
	walk = func(r ojson.Result, path string, headers bool) {
		if !r.IsObject() && !r.IsArray() {
			return
		}
		named := headers && (credentialHeader(r.Get("name").String()) || credentialHeader(r.Get("key").String()))
		tuple := headers && r.IsArray() && credentialHeader(r.Get("0").String())
		index := 0
		r.ForEach(func(k, v ojson.Result) bool {
			key := k.String()
			if r.IsArray() {
				key = fmt.Sprint(index)
				index++
			}
			p := ojson.Escape(key)
			if path != "" {
				p = path + "." + p
			}
			name := strings.ToLower(strings.ReplaceAll(key, "_", "-"))
			lineHeader, _, hasColon := strings.Cut(v.Str, ":")
			structuredCredential := v.Type == ojson.String && (name == "authorization" || name == "authorization-token")
			if structuredCredential || headers && (credentialHeader(name) || named && (name == "value" || name == "values") || tuple && key != "0" || hasColon && credentialHeader(lineHeader)) {
				_ = d.Set(p, "[masked]")
			} else {
				walk(v, p, headers || strings.Contains(name, "headers") || name == "client-metadata" || name == "metadata")
			}
			return true
		})
	}
	walk(ojson.ParseBytes(data), "", false)
	return d.Bytes()
}

// A separate parts object makes references unambiguous even when user data
// contains an object that looks exactly like an archive reference.
func pack(data []byte, put func([]byte) (string, error)) (*ojson.Doc, error) {
	d := object()
	if !ojson.ValidBytes(data) {
		_ = d.Set("base64", base64.StdEncoding.EncodeToString(data))
		return d, nil
	}
	body := ojson.NewDoc(safePayload(data))
	for _, key := range []string{"system", "instructions", "tools", "messages", "input", "contents", "systemInstruction", "toolConfig"} {
		v := body.Get(key)
		if !v.Exists() {
			continue
		}
		if v.IsArray() {
			hashes := make([]string, 0)
			for _, item := range v.Array() {
				h, err := put(canonical(nil, item))
				if err != nil {
					return nil, err
				}
				hashes = append(hashes, h)
			}
			_ = d.Set("parts."+key, hashes)
		} else {
			h, err := put(canonical(nil, v))
			if err != nil {
				return nil, err
			}
			_ = d.Set("parts."+key, h)
		}
		_ = body.Delete(key)
	}
	_ = d.SetRawBytes("body", canonical(nil, ojson.ParseBytes(body.Bytes())))
	return d, nil
}

func unpack(p ojson.Result, blobs map[string][]byte) ([]byte, error) {
	if p.Get("base64").Exists() {
		return []byte(p.Raw), nil
	}
	body := p.Get("body")
	if !body.Exists() {
		return nil, fmt.Errorf("missing packed body")
	}
	d := ojson.NewDocString(body.Raw)
	for key, v := range p.Get("parts").Map() {
		var b bytes.Buffer
		if v.IsArray() {
			b.WriteByte('[')
		}
		refs := []ojson.Result{v}
		if v.IsArray() {
			refs = v.Array()
		}
		for i, r := range refs {
			data, ok := blobs[r.String()]
			if !ok {
				return nil, fmt.Errorf("missing blob %s", r.String())
			}
			if i > 0 {
				b.WriteByte(',')
			}
			b.Write(data)
		}
		if v.IsArray() {
			b.WriteByte(']')
		}
		if err := d.SetRawBytes(ojson.Escape(key), b.Bytes()); err != nil {
			return nil, err
		}
	}
	return d.Bytes(), nil
}

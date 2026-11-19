package tracearchive

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"filippo.io/age"
	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/config"
)

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func recorder(t *testing.T, settings config.TraceArchiveConfig) *Recorder {
	t.Helper()
	settings.Enabled = true
	r := new(Recorder)
	check(t, r.Apply(&config.Config{TraceArchive: settings}))
	t.Cleanup(r.Close)
	return r
}
func submit(t *testing.T, r *Recorder, body, response string) {
	t.Helper()
	req := httptest.NewRequest("POST", "/v1/messages", nil)
	ctx := r.Bind(req, "claude-messages", "trace")
	_, c := Begin(ctx, false, []byte(body))
	if c == nil {
		t.Fatal("dropped test call")
	}
	c.Request("claude", "http", []byte(body))
	c.Chunk([]byte(response))
	c.Finish(200)
}
func TestGrowingConversationAgeExport(t *testing.T) {
	dir := t.TempDir()
	id, err := age.GenerateX25519Identity()
	check(t, err)
	r := recorder(t, config.TraceArchiveConfig{Dir: dir, Recipients: []string{id.Recipient().String()}})
	var msgs []string
	var bodies []string
	resp := `{"content":[{"type":"thinking","thinking":"h","signature":"proof"},{"type":"redacted_thinking","data":"opaque"}],"stop_reason":"end_turn"}`
	for i := range 12 {
		msgs = append(msgs, fmt.Sprintf(`{"role":"user","content":"%s%d"}`, strings.Repeat("abc", 200), i))
		b := fmt.Sprintf(`{"system":"shared","tools":[{"name":"f","n":9007199254740993}],"messages":[%s]}`, strings.Join(msgs, ","))
		bodies = append(bodies, b)
		submit(t, r, b, resp)
	}
	check(t, r.Seal(context.Background()))
	ms, err := listManifests(dir)
	check(t, err)
	if len(ms) != 1 || ms[0].Counts.Blobs != 14 || ms[0].Counts.Calls != 12 {
		t.Fatalf("%+v", ms)
	}
	c := ms[0].Counts
	t.Logf("%d referenced bytes / %d unique bytes = %.2fx", c.Referenced, c.Unique, c.ratio())
	if c.ratio() < 10 {
		t.Fatal(c)
	}
	key := filepath.Join(t.TempDir(), "key")
	check(t, os.WriteFile(key, []byte(id.String()+"\n"), 0600))
	for _, mode := range []string{"verify", "export"} {
		var out bytes.Buffer
		err = command([]string{mode, "--dir", dir, "--identity", key}, &out, io.Discard)
		check(t, err)
		if mode == "export" {
			lines := strings.Split(strings.TrimSpace(out.String()), "\n")
			if len(lines) != len(bodies) {
				t.Fatal(len(lines))
			}
			for i, line := range lines {
				for k, v := range map[string]string{"client_request": bodies[i], "upstream_request": bodies[i], "response": resp} {
					if !bytes.Equal(canonical(nil, ojson.Get(line, k)), canonical(nil, ojson.Parse(v))) {
						t.Fatalf("round trip changed %s in turn %d", k, i)
					}
				}
			}
		}
	}
}
func TestInvalidFooterAndUnresolvedCall(t *testing.T) {
	dir := t.TempDir()
	s, err := newSegment(dir, today())
	check(t, err)
	check(t, s.append(&call{Metadata: Metadata{SchemaVersion: 1}, client: []byte(`{"messages":["hi"]}`)}))
	check(t, s.f.Close())
	raw, err := os.ReadFile(s.path)
	check(t, err)
	footer := entry("footer")
	_ = footer.Set("counts", s.counts)
	_ = footer.Set("sha256", strings.Repeat("0", 64))
	if _, err = scan(bytes.NewReader(append(raw, append(footer.Bytes(), '\n')...)), s.date, true, nil); err == nil {
		t.Fatal("accepted bad footer")
	}
	changed := bytes.ReplaceAll(raw, []byte(`"messages":["`), []byte(`"messages":["bad-`))
	if _, err = scan(bytes.NewReader(changed), s.date, false, nil); err == nil {
		t.Fatal("accepted broken reference")
	}
}

func TestRawFallbackAndFilters(t *testing.T) {
	dir := t.TempDir()
	r := recorder(t, config.TraceArchiveConfig{Dir: dir, ExcludeModels: []string{"private"}, ExcludeEndpoints: []string{"/excluded"}})
	req := httptest.NewRequest("POST", "/excluded", nil)
	if _, c := Begin(r.Bind(req, "messages", "trace"), false, nil); c != nil {
		t.Fatal("captured excluded endpoint")
	}
	submit(t, r, `{"model":"private"}`, `{"private":"never-store"}`)
	submit(t, r, `{"model":"public"}`, "data: truncated")
	r.Close()
	var out bytes.Buffer
	check(t, readArchive(dir, "", "", "export", "calls", nil, &out))
	if strings.Count(out.String(), "\n") != 1 || ojson.GetBytes(out.Bytes(), "raw_frames_base64.0").String() != "ZGF0YTogdHJ1bmNhdGVk" || bytes.Contains(out.Bytes(), []byte("private")) {
		t.Fatal(out.String())
	}
}

func TestTornTailAndStaleSeal(t *testing.T) {
	dir := t.TempDir()
	s, err := newSegment(dir, "2000-01-01")
	check(t, err)
	check(t, s.append(&call{Metadata: Metadata{SchemaVersion: 1}, client: []byte(`{"input":["old"]}`)}))
	_, err = s.f.WriteString(`{"type":"blo`)
	check(t, err)
	check(t, s.f.Close())
	r := recorder(t, config.TraceArchiveConfig{Dir: dir})
	submit(t, r, `{"input":["old"]}`, `{"ok":true}`)
	r.Close()
	var b bytes.Buffer
	check(t, command([]string{"verify", "--dir", dir}, &b, io.Discard))
	if strings.Count(b.String(), "1 calls, 1 blobs") != 2 {
		t.Fatal(b.String())
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.jsonl.zst"))
	check(t, err)
	f, err := os.OpenFile(paths[0], os.O_APPEND|os.O_WRONLY, 0600)
	check(t, err)
	_, err = f.WriteString("x")
	check(t, err)
	check(t, f.Close())
	if command([]string{"verify", "--dir", dir}, io.Discard, io.Discard) == nil {
		t.Fatal("corrupt sealed file accepted")
	}
}
func TestQueueAdmissionAndHeaderMask(t *testing.T) {
	dir := t.TempDir()
	r := recorder(t, config.TraceArchiveConfig{Dir: dir, QueueSize: 1})
	req := httptest.NewRequest("POST", "/v1/responses", nil)
	for _, h := range []string{"Authorization", "X-api-key", "Cookie"} {
		req.Header.Set(h, h+"-secret")
	}
	ctx := r.Bind(req, "responses", "trace")
	body := []byte(`{"headers":{"AUTHORIZATION":"a-secret","X-API-Key":"x-secret","Cookie":"c-secret"},"response_headers":[{"name":"Set-Cookie","value":"named-secret"},["Authorization","tuple-secret"],"x-api-key: string-secret"],"input":"hi"}`)
	_, first := Begin(ctx, true, body)
	for range 1000 {
		if _, c := Begin(ctx, true, body); c != nil {
			t.Fatal("admitted a turn beyond capacity")
		}
	}
	first.Request("codex", "ws", body)
	first.Chunk(body)
	first.Finish(200)
	r.Close()
	if r.dropped.Load() != 1000 {
		t.Fatal(r.dropped.Load())
	}
	paths, err := filepath.Glob(filepath.Join(dir, "*.live"))
	check(t, err)
	b, err := os.ReadFile(paths[0])
	check(t, err)
	if bytes.Contains(b, []byte("-secret")) || !bytes.Contains(b, []byte("[masked]")) {
		t.Fatal("failed to mask header")
	}
	if !bytes.Contains(body, []byte("a-secret")) {
		t.Fatal("mutated caller payload")
	}
}
func TestReconstructProviders(t *testing.T) {
	claude := []string{
		`{"type":"message_start","message":{"model":"claude","content":[],"usage":{"input_tokens":17}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"plan"}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"f1","input":{}}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"n\":42}"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"redacted_thinking","data":"opaque"}}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":8}}`,
		`{"type":"message_stop"}`,
	}
	responses := []string{`{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","encrypted_content":"cipher","summary":[{"text":"summary"}]}}`, `{"type":"response.completed","response":{"id":"r","output":[]}}`}
	chat := []string{`{"choices":[{"index":0,"delta":{"role":"assistant","content":"hel","tool_calls":[{"index":0,"id":"t","type":"function","function":{"name":"f","arguments":"{"}}]}}]}`, `{"choices":[{"index":0,"delta":{"content":"lo","tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls"}]}`, `[DONE]`}
	for _, tt := range []struct {
		name   string
		events []string
		fields map[string]string
	}{
		{"claude", claude, map[string]string{"content.0.thinking": "plan", "content.0.signature": "signed", "content.1.input.n": "42", "content.2.data": "opaque", "stop_reason": "tool_use", "usage.input_tokens": "17"}},
		{"responses", responses, map[string]string{"output.0.encrypted_content": "cipher", "output.0.summary.0.text": "summary"}},
		{"codex-ws", responses, map[string]string{"output.0.encrypted_content": "cipher", "id": "r"}},
		{"chat", chat, map[string]string{"choices.0.message.content": "hello", "choices.0.message.tool_calls.0.function.arguments": "{}", "choices.0.finish_reason": "tool_calls"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var chunks [][]byte
			for _, e := range tt.events {
				if tt.name != "codex-ws" {
					e = "data: " + e
				}
				chunks = append(chunks, []byte(e))
			}
			got, ok := reconstruct(chunks)
			if !ok {
				t.Fatal("reconstruction failed")
			}
			for k, v := range tt.fields {
				if ojson.GetBytes(got, k).String() != v {
					t.Fatalf("%s missing from %s", k, got)
				}
			}
			if _, ok = reconstruct(chunks[:len(chunks)-1]); ok {
				t.Fatal("incomplete stream discarded")
			}
		})
	}
}
func TestUploadRetryAndRetention(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses POSIX fake rclone")
	}
	dir := t.TempDir()
	remote := t.TempDir()
	fake := filepath.Join(t.TempDir(), "rclone")
	check(t, os.WriteFile(fake, []byte("#!/bin/sh\nset -eu\ncase $1 in\ncopyto) cp \"$3\" \"$4\";;\ncat) if [ -e \"$FAIL_RCLONE\" ]; then echo corrupt; else cat \"$3\"; fi;;\nesac\n"), 0700))
	flag := filepath.Join(t.TempDir(), "fail")
	t.Setenv("FAIL_RCLONE", flag)
	check(t, os.WriteFile(flag, nil, 0600))
	w := &worker{cfg: config.TraceArchiveConfig{Dir: dir, MaxLocalSizeMB: 1, Upload: config.TraceUploadConfig{Enabled: true, Binary: fake, Remote: remote}}}
	s, err := newSegment(dir, "2000-01-01")
	check(t, err)
	check(t, s.seal(w.cfg))
	live, err := newSegment(dir, today())
	check(t, err)
	check(t, live.f.Truncate(2<<20))
	check(t, live.f.Close())
	if err = w.maintenance(context.Background()); err == nil {
		t.Fatal("accepted corrupt remote")
	}
	ms, err := listManifests(dir)
	check(t, err)
	if len(ms) != 1 || ms[0].UploadedTo != "" {
		t.Fatal("deleted unconfirmed archive")
	}
	check(t, os.Remove(flag))
	check(t, w.maintenance(context.Background()))
	ms, err = listManifests(dir)
	check(t, err)
	if len(ms) != 0 {
		t.Fatal("retained confirmed archive")
	}
	_, err = os.Stat(live.path)
	check(t, err)
	ms, err = listManifests(remote)
	check(t, err)
	if len(ms) != 1 || ms[0].UploadedTo != remote {
		t.Fatalf("unconfirmed remote manifest: %+v", ms)
	}
	check(t, readArchive(remote, "", "", "verify", "calls", nil, io.Discard))
}

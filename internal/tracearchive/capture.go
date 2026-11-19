package tracearchive

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/MoeForge/moego/base64"
	"github.com/MoeForge/moego/ojson"
	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"
	"github.com/rune-oai/t3code-proxy/internal/buildinfo"
	"github.com/rune-oai/t3code-proxy/sdk/cliproxy/usage"
)

// Only these selected fields cross the archive boundary. In particular neither
// usage.Record (which contains the client API key) nor headers are serialized.
type Metadata struct {
	SchemaVersion int           `json:"schema_version"`
	HubVersion    string        `json:"hub_version"`
	Start         time.Time     `json:"start"`
	FirstByte     *time.Time    `json:"first_byte,omitempty"`
	End           time.Time     `json:"end"`
	LatencyNS     int64         `json:"latency_ns"`
	TTFTNS        int64         `json:"ttft_ns"`
	Endpoint      string        `json:"endpoint"`
	Protocol      string        `json:"client_protocol"`
	UserAgent     string        `json:"user_agent"`
	ClientName    string        `json:"client_name,omitempty"`
	Transport     string        `json:"transport"`
	Stream        bool          `json:"stream"`
	Session       string        `json:"session_id,omitempty"`
	ParentSession string        `json:"parent_session_id,omitempty"`
	TraceID       string        `json:"trace_id,omitempty"`
	RequestID     string        `json:"request_id"`
	Provider      string        `json:"provider,omitempty"`
	Executor      string        `json:"executor,omitempty"`
	Account       string        `json:"auth_index,omitempty"`
	Model         string        `json:"requested_model,omitempty"`
	Alias         string        `json:"alias,omitempty"`
	UpstreamModel string        `json:"upstream_model,omitempty"`
	ResponseModel string        `json:"response_model,omitempty"`
	Effort        string        `json:"reasoning_effort,omitempty"`
	Tier          string        `json:"service_tier,omitempty"`
	Status        int           `json:"status"`
	Failed        bool          `json:"failed"`
	FailureCode   string        `json:"failure_code,omitempty"`
	Attempts      []Attempt     `json:"attempts"`
	Tokens        *usage.Detail `json:"token_usage,omitempty"`
}
type Attempt struct {
	Start     time.Time `json:"start"`
	Account   string    `json:"auth_index,omitempty"`
	Failed    bool      `json:"failed,omitempty"`
	Code      string    `json:"failure_code,omitempty"`
	Provider  string    `json:"provider"`
	Transport string    `json:"transport"`
	Status    int       `json:"status,omitempty"`
}

type call struct {
	reserved int64
	Metadata
	client, upstream, downstream []byte
	chunks                       [][]byte
	encoding                     string
}
type captureKey struct{}
type sourceKey struct{}
type source struct {
	rec      *Recorder
	meta     Metadata
	encoding string
}

func (r *Recorder) Bind(req *http.Request, protocol, traceID string) context.Context {
	m := Metadata{SchemaVersion: 1, HubVersion: buildinfo.Version, Start: time.Now().UTC(), Endpoint: req.URL.Path, Protocol: protocol, UserAgent: req.UserAgent(), ClientName: req.Header.Get("X-Client-Name"), TraceID: traceID, Transport: "http"}
	return context.WithValue(req.Context(), sourceKey{}, source{r, m, req.Header.Get("Content-Encoding")})
}

type Capture struct {
	mu           sync.Mutex // protects only this call's snapshots, never storage or queue waits
	run          *worker
	source       source
	finished     bool
	duplexStatus int // business outcome of the handler-owned turn after bootstrap
	data         *call
}

const maxCaptureBytes = 128 << 20

func Begin(ctx context.Context, ws bool, body []byte) (context.Context, *Capture) {
	src, ok := ctx.Value(sourceKey{}).(source)
	if !ok {
		return ctx, nil
	}
	w := src.rec.active.Load()
	if w == nil || slices.Contains(w.cfg.ExcludeEndpoints, src.meta.Endpoint) {
		return ctx, nil
	}
	select {
	case w.slots <- struct{}{}:
	default:
		w.dropped.Add(1)
		return ctx, nil
	}
	m := src.meta
	m.RequestID = uuid.NewString()
	if ws {
		m.Transport = "ws"
		m.Stream = true
		m.Start = time.Now().UTC()
	}
	c := &Capture{run: w, source: src, data: &call{Metadata: m, encoding: src.encoding}}
	c.Client(body)
	return c.attach(ctx), c
}

// Context routes duplex frame and usage observations to the owning turn.
func (c *Capture) Context(ctx context.Context) context.Context {
	if From(ctx) == c {
		return ctx
	}
	if c == nil {
		return usage.WithRecordObserver(context.WithValue(ctx, captureKey{}, c), nil)
	}
	return c.attach(ctx)
}
func (c *Capture) attach(ctx context.Context) context.Context {
	ctx = context.WithValue(ctx, sourceKey{}, c.source)
	return usage.WithRecordObserver(context.WithValue(ctx, captureKey{}, c), c.observe)
}
func From(ctx context.Context) *Capture {
	if ctx == nil {
		return nil
	}
	c, _ := ctx.Value(captureKey{}).(*Capture)
	return c
}
func Inherit(ctx, src context.Context) context.Context {
	if From(ctx) == nil {
		if c := From(src); c != nil {
			return c.attach(ctx)
		}
		if s, ok := src.Value(sourceKey{}).(source); ok {
			return context.WithValue(ctx, sourceKey{}, s)
		}
	}
	return ctx
}
func (c *Capture) reserve(n int) bool {
	if c.data == nil {
		return false
	}
	c.data.reserved += int64(n)
	total := c.run.memory.Add(int64(n))
	if c.data.reserved > maxCaptureBytes || total > 256<<20 {
		c.run.memory.Add(-c.data.reserved)
		c.data = nil
		c.run.dropped.Add(1)
		return false
	}

	return true
}
func (c *Capture) Client(p []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.reserve(len(p)) {
		c.data.client = append(c.data.client, p...)
	}
}
func (c *Capture) Request(provider, transport string, p []byte) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.reserve(len(p)) {
		d := c.data
		c.duplexStatus = 0
		d.Provider = provider
		d.Attempts = append(d.Attempts, Attempt{Start: time.Now().UTC(), Provider: provider, Transport: transport})
		d.upstream = bytes.Clone(p)
		d.chunks = nil
	}
}
func (c *Capture) Status(status int) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if d := c.data; d != nil && len(d.Attempts) > 0 {
		d.Attempts[len(d.Attempts)-1].Status = status
	}
}
func (c *Capture) FirstByte() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.data != nil {
		c.data.markFirstByte()
	}
}
func (d *call) markFirstByte() {
	if d.FirstByte != nil {
		return
	}
	now := time.Now().UTC()
	d.FirstByte = &now
	d.TTFTNS = now.Sub(d.Start).Nanoseconds()
}
func (c *Capture) chunk(p []byte, upstream bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.reserve(len(p) + 24) {
		d := c.data
		if len(p) > 0 {
			d.markFirstByte()
		}
		if upstream {
			d.chunks = append(d.chunks, bytes.Clone(p))
		} else {
			d.downstream = append(d.downstream, p...)
		}
	}
}
func (c *Capture) Chunk(p []byte)          { c.chunk(p, true) }
func (c *Capture) ClientResponse(p []byte) { c.chunk(p, false) }
func (c *Capture) observe(r usage.Record) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := c.data
	if d == nil {
		return
	}
	d.RequestID = r.RequestID
	if r.TraceID != "" {
		d.TraceID = r.TraceID
	}
	d.Session = r.SessionID
	d.ParentSession = r.ParentSessionID
	d.Executor = r.ExecutorType
	d.Account = r.AuthIndex
	if n := len(d.Attempts); n > 0 {
		a := &d.Attempts[n-1]
		a.Account = r.AuthIndex
		a.Failed = r.Failed
		a.Code = r.Fail.Code
		if a.Status == 0 && r.Fail.StatusCode > 0 {
			a.Status = r.Fail.StatusCode
		}
	}
	d.Alias = r.Alias
	d.ResponseModel = r.ResponseModel
	d.Effort = r.ReasoningEffort
	d.Tier = r.ServiceTier
	d.Failed = r.Failed
	d.FailureCode = r.Fail.Code
	d.Tokens = &r.Detail
	if r.TTFT > 0 {
		d.TTFTNS = r.TTFT.Nanoseconds()
	}
	if r.Provider != "" {
		d.Provider = r.Provider
	}
	d.Model = r.Model
}

// MarkDuplexResult lets the handler finish its initial turn once a committed
// response ends, even while the socket continues serving follow-up turns.
func (c *Capture) MarkDuplexResult(status int) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.duplexStatus = status
	c.mu.Unlock()
}

// FinishDuplexResult commits a marked turn after the handler delivers its terminal frame.
func (c *Capture) FinishDuplexResult() {
	if c == nil {
		return
	}
	c.mu.Lock()
	status := c.duplexStatus
	c.mu.Unlock()
	if status != 0 {
		c.Finish(status)
	}
}

func (c *Capture) Finish(status int) {
	if c == nil {
		return
	}
	c.mu.Lock()
	if c.finished {
		c.mu.Unlock()
		return
	}
	c.finished = true
	d := c.data
	c.data = nil
	c.mu.Unlock()
	if d == nil {
		<-c.run.slots
		return
	}
	d.End = time.Now().UTC()
	d.LatencyNS = d.End.Sub(d.Start).Nanoseconds()
	d.Status = status
	d.Failed = d.Failed || status >= 400
	c.run.submit(d)
}

func (d *call) prepare() {
	if strings.EqualFold(d.encoding, "zstd") && !ojson.ValidBytes(d.client) {
		if dec, err := zstd.NewReader(bytes.NewReader(d.client), zstd.WithDecoderMaxMemory(maxCaptureBytes)); err == nil {
			if b, e := io.ReadAll(io.LimitReader(dec, maxCaptureBytes+1)); e == nil && len(b) <= maxCaptureBytes {
				d.client = b
			}
			dec.Close()
		}
	}
	if m := ojson.GetBytesNoCopy(d.client, "model").String(); m != "" {
		d.Model = m
	}
	d.Stream = d.Stream || ojson.GetBytesNoCopy(d.client, "stream").Bool()
	d.UpstreamModel = ojson.GetBytesNoCopy(d.upstream, "model").String()
}

func (d *call) encode(put func([]byte) (string, error)) ([]byte, error) {
	doc := entry("call")
	_ = doc.Set("call", d.Metadata)
	for _, v := range []struct {
		name string
		b    []byte
	}{{"client_request", d.client}, {"upstream_request", d.upstream}} {
		if len(v.b) == 0 {
			continue
		}
		packed, err := pack(v.b, put)
		if err != nil {
			return nil, err
		}
		_ = doc.SetRawBytes("call."+v.name, packed.Bytes())
	}
	chunks := d.chunks
	if len(chunks) == 0 && len(d.downstream) > 0 {
		chunks = [][]byte{d.downstream}
	}
	if response, ok := reconstruct(chunks); ok {
		_ = doc.SetRawBytes("call.response", canonical(nil, ojson.ParseBytes(response)))
		if d.ResponseModel == "" {
			_ = doc.Set("call.response_model", ojson.GetBytesNoCopy(response, "model").String())
		}
	} else if len(chunks) > 0 {
		frames := make([]string, len(chunks))
		for i, p := range chunks {
			frames[i] = base64.StdEncoding.EncodeToString(redactFrame(p))
		}
		_ = doc.Set("call.raw_frames_base64", frames)
	}
	// Some translators change content or model IDs. Preserve the downstream
	// result as well when it differs from the provider-native replay material.
	if len(d.chunks) > 0 && len(d.downstream) > 0 {
		if response, ok := reconstruct([][]byte{d.downstream}); ok {
			value := canonical(nil, ojson.ParseBytes(response))
			if !bytes.Equal(value, []byte(doc.Get("call.response").Raw)) {
				_ = doc.SetRawBytes("call.client_response", value)
			}
		} else {
			_ = doc.Set("call.client_raw_base64", base64.StdEncoding.EncodeToString(redactFrame(d.downstream)))
		}
	}
	return doc.Bytes(), nil
}

func redactFrame(p []byte) []byte {
	if ojson.ValidBytes(p) {
		return safePayload(p)
	}
	var b bytes.Buffer
	for line := range bytes.SplitAfterSeq(p, []byte("\n")) {
		if raw, ok := bytes.CutPrefix(line, []byte("data:")); ok && ojson.ValidBytes(raw) {
			b.WriteString("data:")
			b.Write(safePayload(raw))
		} else {
			b.Write(line)
		}
	}
	return b.Bytes()
}

package api

import (
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/httpwire"
	"github.com/rune-oai/t3code-proxy/internal/logging"
	"github.com/rune-oai/t3code-proxy/internal/tracearchive"
	log "github.com/sirupsen/logrus"
)

func (s *Server) configureArchive(c *config.Config) {
	if err := s.archive.Apply(c); err != nil {
		log.WithError(err).Error("trace archive unavailable")
	}
}

type traceBody struct {
	io.ReadCloser
	c *tracearchive.Capture
}

func (b traceBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.c.Client(p[:n])
	return n, err
}

type traceWriter struct {
	gin.ResponseWriter
	c *tracearchive.Capture
}

func (w traceWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w traceWriter) FlushError() error           { return httpwire.FlushResponse(w.ResponseWriter) }
func (w traceWriter) Write(p []byte) (int, error) {
	n, e := w.ResponseWriter.Write(p)
	w.c.ClientResponse(p[:n])
	return n, e
}
func (w traceWriter) WriteString(p string) (int, error) {
	n, e := w.ResponseWriter.WriteString(p)
	w.c.ClientResponse([]byte(p[:n]))
	return n, e
}

func (s *Server) traceMiddleware(c *gin.Context) {
	if !s.archive.Enabled() && !(c.Request.Method == http.MethodGet && strings.HasSuffix(c.FullPath(), "/responses")) {
		return
	}
	path := c.FullPath()
	var protocol string
	switch {
	case strings.Contains(path, "/v1/messages"):
		protocol = "claude-messages"
	case strings.HasSuffix(path, "/responses") || strings.HasSuffix(path, "/responses/compact"):
		protocol = "openai-responses"
	case strings.HasSuffix(path, "/alpha/search"):
		protocol = "codex-search"
	case path == "/muse-code/search" || path == "/muse-code/browser_open":
		protocol = "muse-code"
	case strings.HasSuffix(path, "/chat/completions"):
		protocol = "chat-completions"
	case strings.Contains(path, "/v1beta/models/") || strings.HasSuffix(path, "/interactions"):
		protocol = "gemini"
	case strings.HasSuffix(path, "/completions") || strings.Contains(path, "/images/") || strings.Contains(path, "/videos") || strings.HasSuffix(path, "/audio/speech") || strings.HasSuffix(path, "/tts"):
		protocol = "openai"
	default:
		return
	}
	if c.Request.Method != http.MethodPost && !(protocol == "openai-responses" && c.Request.Method == http.MethodGet) {
		return
	}
	ctx := s.archive.Bind(c.Request, protocol, logging.GetGinRequestID(c))
	if c.Request.Method == http.MethodGet {
		c.Request = c.Request.WithContext(ctx)
		return
	}
	ctx, capture := tracearchive.Begin(ctx, false, nil)
	if capture == nil {
		return
	}
	c.Request = c.Request.WithContext(ctx)
	if c.Request.Body != nil {
		c.Request.Body = traceBody{c.Request.Body, capture}
	}
	w := traceWriter{c.Writer, capture}
	c.Writer = w
	defer func() { capture.Finish(w.Status()) }()
	c.Next()
}

func (s *Server) sealTraces(c *gin.Context) {
	if err := s.archive.Seal(c.Request.Context()); err != nil {
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

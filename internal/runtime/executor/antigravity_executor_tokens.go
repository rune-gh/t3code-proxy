package executor

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/MoeForge/moego/ojson"
	"github.com/rune-oai/t3code-proxy/internal/runtime/executor/helps"
	"github.com/rune-oai/t3code-proxy/internal/thinking"
	"github.com/rune-oai/t3code-proxy/internal/util"
	cliproxyauth "github.com/rune-oai/t3code-proxy/sdk/cliproxy/auth"
	cliproxyexecutor "github.com/rune-oai/t3code-proxy/sdk/cliproxy/executor"
	sdktranslator "github.com/rune-oai/t3code-proxy/sdk/translator"
	log "github.com/sirupsen/logrus"
)

// CountTokens counts tokens for the given request using the Antigravity API.
func (e *AntigravityExecutor) CountTokens(ctx context.Context, auth *cliproxyauth.Auth, req cliproxyexecutor.Request, opts cliproxyexecutor.Options) (cliproxyexecutor.Response, error) {
	baseModel := thinking.ParseSuffix(req.Model).ModelName
	if antigravityInTOSPause(e.cfg, auth) {
		return cliproxyexecutor.Response{}, statusErr{code: http.StatusServiceUnavailable, msg: "antigravity pool paused after TOS_VIOLATION"}
	}

	responseFormat := cliproxyexecutor.ResponseFormatOrSource(opts)
	to := sdktranslator.FromString("antigravity")
	respCtx := context.WithValue(ctx, "alt", opts.Alt)

	prepared, errPrepare := e.prepareAntigravityRequest(ctx, auth, req, opts, baseModel, false, true)
	if errPrepare != nil {
		return cliproxyexecutor.Response{}, errPrepare
	}
	auth = prepared.auth
	cliproxyauth.NotifyAccessTokenFingerprint(ctx, auth)
	if strings.TrimSpace(prepared.token) == "" {
		return cliproxyexecutor.Response{}, statusErr{code: http.StatusUnauthorized, msg: "missing access token"}
	}

	req.Payload = prepared.originalPayload
	selection := prepared.model
	doc := ojson.NewDoc(prepared.translated)
	if errThinking := helps.ApplyAntigravityRequestThinkingDoc(doc, req, opts, selection); errThinking != nil {
		return cliproxyexecutor.Response{}, errThinking
	}
	e.obfuscateSensitiveWordsDoc(doc)
	helps.PrepareAntigravityClaudeStructuredOutputDoc(selection.ID, doc)
	sanitizeAntigravityGeminiRequestSignaturesDoc(selection.ID, doc)
	if _, errReplay := prepareAntigravityGeminiCountTokensReasoningReplayPayloadDoc(ctx, selection.ID, req, opts, doc); errReplay != nil {
		return cliproxyexecutor.Response{}, errReplay
	}
	ensureAntigravityGeminiLeadingUserContentDoc(selection.ID, doc)

	if selection.MaxOutputTokens > 0 {
		modelPath := strings.TrimSpace(selection.ID)
		if !strings.HasPrefix(modelPath, "models/") {
			modelPath = "models/" + modelPath
		}
		_ = doc.Set("request.model", modelPath)
		_ = doc.Set("request.generationConfig.maxOutputTokens", selection.MaxOutputTokens)
	}

	_ = doc.Delete("project")
	_ = doc.Delete("model")
	_ = doc.Delete("request.safetySettings")
	_ = doc.Delete("request.toolConfig")
	_ = doc.Delete("request.labels")
	_ = doc.Delete("request.sessionId")

	base := resolveAntigravityRequestBaseURL(auth)
	httpClient := newAntigravityHTTPClient(ctx, e.cfg, auth, 0)

	var authID, authLabel, authType, authValue string
	if auth != nil {
		authID = auth.ID
		authLabel = auth.Label
		authType, authValue = auth.AccountInfo()
	}

	var requestURL strings.Builder
	requestURL.WriteString(base)
	requestURL.WriteString(antigravityCountTokensPath)
	if opts.Alt != "" {
		requestURL.WriteString("?$alt=")
		requestURL.WriteString(url.QueryEscape(opts.Alt))
	}

	ctx = helps.WithPayloadFinalizer(ctx, helps.NewPayloadFinalizerWithSourceModels(e.cfg, e.Identifier(), selection.ID, to.String(), "request", prepared.originalTranslated, req, opts, baseModel))
	helps.FinalizePayloadDoc(ctx, doc)
	payload := doc.Bytes()
	httpReq, errReq := http.NewRequestWithContext(ctx, http.MethodPost, requestURL.String(), bytes.NewReader(payload))
	if errReq != nil {
		return cliproxyexecutor.Response{}, errReq
	}
	// No httpReq.Close: keep the shared Antigravity connection pool usable.
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+prepared.token)
	httpReq.Header.Set("User-Agent", resolveUserAgent(auth))
	if host := resolveHost(base); host != "" {
		httpReq.Host = host
	}
	var attrs map[string]string
	if auth != nil {
		attrs = auth.Attributes
	}
	util.ApplyCustomHeadersFromAttrs(httpReq, attrs)

	helps.RecordAPIRequest(ctx, e.cfg, helps.UpstreamRequestLog{
		URL:       requestURL.String(),
		Method:    http.MethodPost,
		Headers:   httpReq.Header.Clone(),
		Body:      payload,
		Provider:  e.Identifier(),
		AuthID:    authID,
		AuthLabel: authLabel,
		AuthType:  authType,
		AuthValue: authValue,
	})

	cliproxyexecutor.MarkUpstreamAttempt(ctx)
	httpResp, errDo := helps.WithAntigravityHTTPClientTrace(httpClient, auth, "count_tokens").Do(httpReq)
	if errDo != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, errDo)
		return cliproxyexecutor.Response{}, errDo
	}

	helps.RecordAPIResponseMetadata(ctx, e.cfg, httpResp.StatusCode, httpResp.Header.Clone())
	bodyBytes, errRead := io.ReadAll(httpResp.Body)
	if errClose := httpResp.Body.Close(); errClose != nil {
		log.Errorf("antigravity executor: close response body error: %v", errClose)
	}
	helps.AppendAPIResponseChunk(ctx, e.cfg, bodyBytes)
	if errRead != nil {
		helps.RecordAPIResponseError(ctx, e.cfg, errRead)
		return cliproxyexecutor.Response{}, errRead
	}

	if httpResp.StatusCode >= http.StatusOK && httpResp.StatusCode < http.StatusMultipleChoices {
		count := ojson.GetBytesNoCopy(bodyBytes, "totalTokens").Int()
		translated := sdktranslator.TranslateTokenCount(respCtx, to, responseFormat, count, bodyBytes)
		return cliproxyexecutor.Response{Payload: translated, Headers: httpResp.Header.Clone()}, nil
	}

	if httpResp.StatusCode == http.StatusForbidden {
		e.applyAntigravityTOSState(e.cfg, auth, bodyBytes)
	}
	sErr := newAntigravityStatusErr(httpResp.StatusCode, bodyBytes)
	if httpResp.StatusCode == http.StatusTooManyRequests {
		closeAntigravityAuthIdleTransports(auth)
		if retryAfter, parseErr := helps.ParseRetryDelay(bodyBytes); parseErr == nil && retryAfter != nil {
			sErr.retryAfter = retryAfter
		}
	}
	return cliproxyexecutor.Response{}, sErr
}

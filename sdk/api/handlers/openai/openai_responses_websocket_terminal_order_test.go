package openai

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/http"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/MoeForge/moego/ojson"
	"github.com/gorilla/websocket"
	"github.com/rune-oai/t3code-proxy/internal/interfaces"
)

// Pause a write before sending it or after delivery while writeMu is still held.
type pausedWebsocketWriteConn struct {
	net.Conn
	before  bool
	pause   atomic.Bool
	entered chan struct{}
	release chan struct{}
}

func (c *pausedWebsocketWriteConn) Write(payload []byte) (int, error) {
	pause := c.pause.Swap(false)
	if pause && c.before {
		close(c.entered)
		<-c.release
	}
	n, err := c.Conn.Write(payload)
	if pause && !c.before {
		close(c.entered)
		<-c.release
	}
	return n, err
}

func TestResponsesWebsocketTerminalErrorWaitsForWriter(t *testing.T) {
	for _, phase := range []string{"response.created", "ping", "terminal"} {
		t.Run(phase, func(t *testing.T) {
			clientRaw, serverRaw := net.Pipe()
			defer func() { _ = clientRaw.Close() }()
			defer func() { _ = serverRaw.Close() }()
			paused := &pausedWebsocketWriteConn{Conn: serverRaw, before: phase == "terminal", entered: make(chan struct{}), release: make(chan struct{})}
			serverConn := make(chan *websocket.Conn, 1)
			go func() {
				req, err := http.ReadRequest(bufio.NewReader(serverRaw))
				if err != nil {
					t.Error(err)
					return
				}
				conn, err := responsesWebsocketUpgrader.Upgrade(newHijackableWebsocketResponseWriter(paused), req, nil)
				if err != nil {
					t.Error(err)
					return
				}
				serverConn <- conn
			}()
			dialer := websocket.Dialer{NetDialContext: func(context.Context, string, string) (net.Conn, error) { return clientRaw, nil }}
			client, resp, err := dialer.Dial("ws://example.com/responses", nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = resp.Body.Close() }()
			frames := make(chan []byte, 2)
			readDone := make(chan error, 1)
			client.SetPingHandler(func(string) error { frames <- nil; return nil })
			go func() {
				defer close(frames)
				for {
					_, payload, errRead := client.ReadMessage()
					if errRead != nil {
						readDone <- errRead
						return
					}
					frames <- payload
				}
			}()
			writer := newResponsesWebsocketWriter(<-serverConn)
			paused.pause.Store(true)
			errMsg := &interfaces.ErrorMessage{StatusCode: http.StatusTooManyRequests, Error: websocketPinnedFailoverStatusError{
				status: http.StatusTooManyRequests, msg: `{"error":{"type":"usage_limit_reached","message":"quota exhausted"}}`,
			}}
			writeDone := make(chan error, 1)
			go func() {
				switch phase {
				case "response.created":
					writeDone <- writeResponsesWebsocketPayload(writer, nil, []byte(`{"type":"response.created"}`), time.Now())
				case "ping":
					writeDone <- writer.writePing()
				case "terminal":
					_, _, err := writeResponsesWebsocketTerminalError(writer, nil, errMsg, nil)
					writeDone <- err
				}
			}()
			if phase != "terminal" {
				<-frames
			}
			<-paused.entered
			contenderDone := make(chan struct{})
			go func() {
				_, _, _ = writeResponsesWebsocketTerminalError(writer, nil, errMsg, nil)
				// Model the handler's deferred socket teardown after forwarding returns.
				_, _ = writer.closeWithoutError()
				_ = writer.conn.Close()
				close(contenderDone)
			}()
			waitForTerminalWriterOrClose(t, contenderDone)
			select {
			case <-contenderDone:
				t.Error("terminal contender closed the socket before the active writer returned")
			default:
			}
			close(paused.release)
			frame, ok := <-frames
			if !ok {
				t.Fatalf("terminal frame was lost: %v", <-readDone)
			}
			if got := ojson.GetBytesNoCopy(frame, "status").Int(); got != http.StatusTooManyRequests {
				t.Fatalf("terminal status = %d, frame = %s", got, frame)
			}
			if err := <-writeDone; err != nil && !errors.Is(err, websocket.ErrCloseSent) {
				t.Fatal(err)
			}
			<-contenderDone
		})
	}
}

// A mutex wait is not durably blocked under testing/synctest. Observe the
// contender at that lock (or its premature return) before releasing the I/O
// barrier, so the regression does not depend on scheduler speed or sleeps.
func waitForTerminalWriterOrClose(t *testing.T, done <-chan struct{}) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	stack := make([]byte, 1<<20)
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return
		default:
		}
		n := runtime.Stack(stack, true)
		for _, goroutine := range strings.Split(string(stack[:n]), "\n\n") {
			if strings.Contains(goroutine, "[sync.Mutex.Lock]") && strings.Contains(goroutine, "(*responsesWebsocketWriter).closeWithPayload") {
				return
			}
		}
		runtime.Gosched()
	}
	t.Fatal("terminal writer did not reach the write lock")
}

func TestResponsesWebsocketKeepAliveDoesNotCancelTerminalWrite(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancelCause(context.Background())
		defer cancel(nil)
		writer := newResponsesWebsocketWriter(&websocket.Conn{})
		writer.closing.Store(true)
		intervals := make(chan time.Duration, 1)
		intervals <- time.Nanosecond
		writer.keepAlive(ctx, cancel, intervals)
		if ctx.Err() != nil {
			t.Fatalf("keepalive canceled the socket during terminal delivery: %v", context.Cause(ctx))
		}
	})
}

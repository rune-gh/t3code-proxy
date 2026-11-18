package logging

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/synctest"
)

func TestStreamingLogWritersPreserveChunksWhenQueueIsFull(t *testing.T) {
	for _, target := range []string{"file", "home"} {
		t.Run(target, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				queue := make(chan []byte, 1)
				queue <- []byte("first")
				var write func([]byte)
				if target == "file" {
					write = (&FileStreamingLogWriter{chunkChan: queue}).WriteChunkAsync
				} else {
					write = (&homeStreamingLogWriter{chunkChan: queue}).WriteChunkAsync
				}
				done := make(chan struct{})
				go func() {
					chunk := []byte("reasoning event")
					write(chunk)
					chunk[0] = 'X'
					close(done)
				}()
				synctest.Wait()
				select {
				case <-done:
					t.Fatal("writer dropped a chunk instead of waiting for queue space")
				default:
				}
				if got := string(<-queue); got != "first" {
					t.Fatalf("first chunk = %q", got)
				}
				<-done
				if got := string(<-queue); got != "reasoning event" {
					t.Fatalf("queued chunk = %q", got)
				}
			})
		})
	}
}

func TestStreamingLogRetainsSpoolWhenFinalLogCannotBeCreated(t *testing.T) {
	dir := t.TempDir()
	logger := NewFileRequestLogger(true, dir, "", 0)
	stream, errStream := logger.LogStreamingRequest("/v1/messages", "POST", nil, []byte("request body"), "retention")
	if errStream != nil {
		t.Fatal(errStream)
	}
	writer := stream.(*FileStreamingLogWriter)
	requestPath, responsePath := writer.requestBodyPath, writer.responseBodyPath
	writer.WriteChunkAsync([]byte("reasoning event"))
	// A regular file cannot be used as the final log directory.
	writer.logsDir = requestPath
	if errClose := writer.Close(); errClose == nil {
		t.Fatal("expected final log creation to fail")
	}
	for path, want := range map[string]string{requestPath: "request body", responsePath: "reasoning event"} {
		got, errRead := os.ReadFile(path)
		if errRead != nil || string(got) != want {
			t.Fatalf("spool %s = %q, %v", path, got, errRead)
		}
	}
}

func TestStreamingLogPreservesCompleteResponse(t *testing.T) {
	dir := t.TempDir()
	logger := NewFileRequestLogger(true, dir, "", 0)
	stream, errStream := logger.LogStreamingRequest("/v1/messages", "POST", nil, nil, "complete")
	if errStream != nil {
		t.Fatal(errStream)
	}
	const chunk = "data: {\"type\":\"thinking_delta\",\"thinking\":\"reasoning event\"}\n\n"
	const count = 2000
	for range count {
		stream.WriteChunkAsync([]byte(chunk))
	}
	if errClose := stream.Close(); errClose != nil {
		t.Fatal(errClose)
	}
	files, errGlob := filepath.Glob(filepath.Join(dir, "*.log"))
	if errGlob != nil || len(files) != 1 {
		t.Fatalf("logs = %v, %v", files, errGlob)
	}
	body, errRead := os.ReadFile(files[0])
	if errRead != nil {
		t.Fatal(errRead)
	}
	if got := strings.Count(string(body), chunk); got != count {
		t.Fatalf("retained %d of %d reasoning events", got, count)
	}
	spools, errGlob := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if errGlob != nil || len(spools) != 0 {
		t.Fatalf("successful log left spool files: %v, %v", spools, errGlob)
	}
}

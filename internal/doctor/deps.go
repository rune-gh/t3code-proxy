package doctor

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"time"
)

// Short timeouts: doctor is a local diagnostic, never proxy traffic.
const (
	commandTimeout = 5 * time.Second
	httpTimeout    = 5 * time.Second
	maxBodyBytes   = 64 << 10
)

// Runner runs external commands. Tests replace it with a fake.
type Runner interface {
	// LookPath reports the resolved path of a command, or an error when absent.
	LookPath(name string) (string, error)
	// Run executes name with args and returns combined stdout and stderr.
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

// HTTPGetter fetches a URL and returns the status code and a bounded body.
type HTTPGetter interface {
	Get(ctx context.Context, url string) (status int, body []byte, err error)
}

// PortProber reports whether a TCP address can be bound right now.
type PortProber interface {
	CanListen(addr string) bool
}

// Clock supplies the current time for report timestamps.
type Clock interface {
	Now() time.Time
}

// FileSystem is the read-only subset of the OS file API the checks use.
type FileSystem interface {
	ReadFile(name string) ([]byte, error)
	ReadDir(name string) ([]os.DirEntry, error)
	Stat(name string) (os.FileInfo, error)
}

type execRunner struct{}

func (execRunner) LookPath(name string) (string, error) { return exec.LookPath(name) }

func (execRunner) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

type httpGetter struct{ client *http.Client }

func (g httpGetter) Get(ctx context.Context, url string) (int, []byte, error) {
	ctx, cancel := context.WithTimeout(ctx, httpTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("User-Agent", "t3code-proxy-doctor")
	resp, err := g.client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	return resp.StatusCode, body, err
}

type netProber struct{}

func (netProber) CanListen(addr string) bool {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

type osFS struct{}

func (osFS) ReadFile(name string) ([]byte, error)       { return os.ReadFile(name) }
func (osFS) ReadDir(name string) ([]os.DirEntry, error) { return os.ReadDir(name) }
func (osFS) Stat(name string) (os.FileInfo, error)      { return os.Stat(name) }

func isNotExist(err error) bool { return errors.Is(err, os.ErrNotExist) }

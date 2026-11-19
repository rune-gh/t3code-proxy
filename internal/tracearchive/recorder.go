package tracearchive

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rune-oai/t3code-proxy/internal/config"
	"github.com/rune-oai/t3code-proxy/internal/util"
	log "github.com/sirupsen/logrus"
	bolt "go.etcd.io/bbolt"
)

type Recorder struct {
	mu        sync.Mutex
	active    atomic.Pointer[worker]
	cfg       config.TraceArchiveConfig
	dropped   atomic.Uint64
	lastError string
}
type worker struct {
	memory                      atomic.Int64
	cfg                         config.TraceArchiveConfig
	dropped                     *atomic.Uint64
	slots                       chan struct{}
	queue                       chan *call
	gate                        sync.RWMutex
	closed                      bool
	done                        chan struct{}
	seal                        chan chan error
	wake                        chan struct{}
	maintenanceDone             chan struct{}
	cancel                      context.CancelFunc
	lock                        *bolt.DB
	segment                     *segment // owned by writer goroutine
	statusMu                    sync.Mutex
	live                        counts
	date, lastError, lastUpload string
	failed                      atomic.Bool
}

func Directory(c *config.Config) (string, error) {
	if c.TraceArchive.Dir != "" {
		return filepath.Abs(c.TraceArchive.Dir)
	}
	dir, err := util.ResolveAuthDir(c.AuthDir)
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "traces"), nil
}
func (r *Recorder) Apply(c *config.Config) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cfg := c.TraceArchive
	dir, err := Directory(c)
	if err != nil {
		return err
	}
	cfg.Dir = dir
	if cfg.QueueSize == 0 {
		cfg.QueueSize = 32
	}
	if w := r.active.Load(); w != nil && reflect.DeepEqual(cfg, w.cfg) && !w.failed.Load() {
		return nil
	}
	r.stop()
	r.cfg = cfg
	r.lastError = ""
	if !cfg.Enabled {
		return nil
	}
	if err = cfg.Validate(); err == nil {
		err = r.start(cfg)
	}
	if err != nil {
		r.lastError = err.Error()
	}
	return err
}
func (r *Recorder) Enabled() bool { w := r.active.Load(); return w != nil && !w.failed.Load() }
func (r *Recorder) start(cfg config.TraceArchiveConfig) error {
	if err := os.MkdirAll(cfg.Dir, 0700); err != nil {
		return err
	}
	lock, err := bolt.Open(filepath.Join(cfg.Dir, ".writer.lock"), 0600, &bolt.Options{Timeout: time.Millisecond})
	if err != nil {
		return fmt.Errorf("open trace archive writer lock: %w", err)
	}
	w := &worker{cfg: cfg, lock: lock, dropped: &r.dropped, slots: make(chan struct{}, cfg.QueueSize), queue: make(chan *call, cfg.QueueSize), seal: make(chan chan error), done: make(chan struct{}), wake: make(chan struct{}, 1), maintenanceDone: make(chan struct{})}
	if err = w.recover(); err != nil {
		if w.segment != nil && w.segment.f != nil {
			closeLogged(w.segment.f)
		}
		closeLogged(lock)
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	w.cancel = cancel
	w.snapshot()
	go w.run()
	go w.maintain(ctx)
	r.active.Store(w)
	return nil
}
func (w *worker) recover() error {
	entries, err := os.ReadDir(w.cfg.Dir)
	if err != nil {
		return err
	}
	ms, err := listManifests(w.cfg.Dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		// Only this process holds the directory writer lock.
		if strings.HasPrefix(e.Name(), ".trace-tmp-") && e.Type().IsRegular() {
			if err := os.Remove(filepath.Join(w.cfg.Dir, e.Name())); err != nil {
				return err
			}
			continue
		}
		m := segmentName.FindStringSubmatch(e.Name())
		if m == nil || m[3] != "live" {
			continue
		}
		if w.segment != nil {
			return errors.New("multiple current live segments")
		}
		s, err := recoverSegment(filepath.Join(w.cfg.Dir, e.Name()), m[1])
		if err != nil {
			return err
		}
		w.segment = s
		target := strings.TrimSuffix(s.path, ".live") + ".jsonl.zst"
		_, plainErr := os.Stat(target)
		_, ageErr := os.Stat(target + ".age")
		committed := false
		for _, manifest := range ms {
			dest := filepath.Join(w.cfg.Dir, manifest.File)
			if dest != target && dest != target+".age" {
				continue
			}
			h, n, err := fileHash(dest)
			if err != nil {
				return err
			}
			if h != manifest.SHA256 || n != manifest.Size || manifest.SourceSHA256 != s.checksum() {
				return errors.New("live and committed trace segment disagree")
			}
			if err = s.f.Close(); err != nil {
				return err
			}
			s.f = nil
			if err = os.Remove(s.path); err != nil {
				return err
			}
			w.segment = nil
			committed = true
			break
		}
		if committed {
			continue
		}
		if m[1] != today() || plainErr == nil || ageErr == nil {
			if err = w.sealSegment(); err != nil {
				return err
			}
			// A crash before manifest publication can leave an orphan with the old
			// encryption suffix. The replacement is durable before removing the orphan.
			orphan := target + ".age"
			if len(w.cfg.Recipients) > 0 {
				orphan = target
			}
			if err = os.Remove(orphan); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}
func today() string        { return time.Now().UTC().Format(time.DateOnly) }
func (r *Recorder) Close() { r.mu.Lock(); defer r.mu.Unlock(); r.stop() }
func (r *Recorder) stop() {
	w := r.active.Swap(nil)
	if w == nil {
		return
	}
	w.gate.Lock()
	w.closed = true
	close(w.queue)
	w.gate.Unlock()
	w.cancel()
	<-w.done
	<-w.maintenanceDone
	closeLogged(w.lock)
}
func (w *worker) submit(d *call) {
	if w.gate.TryRLock() {
		if !w.closed && !w.failed.Load() {
			select {
			case w.queue <- d:
				w.gate.RUnlock()
				return
			default:
			}
		}
		w.gate.RUnlock()
	}
	w.memory.Add(-d.reserved)
	<-w.slots
	w.dropped.Add(1)
}
func (w *worker) snapshot() {
	w.statusMu.Lock()
	defer w.statusMu.Unlock()
	w.live = counts{}
	w.date = ""
	if w.segment != nil {
		w.live = w.segment.counts
		w.date = w.segment.date
	}
}
func (w *worker) sealSegment() error {
	if w.segment == nil {
		return nil
	}
	if err := w.segment.seal(w.cfg); err != nil {
		return err
	}
	w.segment = nil
	w.snapshot()
	select {
	case w.wake <- struct{}{}:
	default:
	}
	return nil
}
func (w *worker) roll() error {
	if w.segment != nil && w.segment.date != today() {
		return w.sealSegment()
	}
	return nil
}
func (w *worker) record(d *call) error {
	d.prepare()
	if !withinDepth(d.client) || !withinDepth(d.upstream) || !withinDepth(d.downstream) || slices.ContainsFunc(d.chunks, func(p []byte) bool { return !withinDepth(p) }) {
		w.dropped.Add(1)
		return nil
	}
	if slices.Contains(w.cfg.ExcludeModels, d.Model) {
		return nil
	}
	if err := w.roll(); err != nil {
		return err
	}
	if w.segment == nil {
		s, err := newSegment(w.cfg.Dir, today())
		if err != nil {
			return err
		}
		w.segment = s
	}
	err := w.segment.append(d)
	w.snapshot()
	return err
}
func (w *worker) fail(err error) {
	if err != nil {
		w.failed.Store(true)
		w.statusMu.Lock()
		w.lastError = err.Error()
		w.statusMu.Unlock()
		log.WithError(err).Error("trace archive writer stopped")
	}
}
func (w *worker) consume(d *call) {
	if w.failed.Load() {
		w.dropped.Add(1)
	} else if err := w.record(d); err != nil {
		w.dropped.Add(1)
		w.fail(err)
	}
	w.memory.Add(-d.reserved)
	<-w.slots
}
func (w *worker) run() {
	defer close(w.done)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	defer func() {
		if w.segment != nil && w.segment.f != nil {
			closeLogged(w.segment.f)
		}
	}()
	for {
		select {
		case d, ok := <-w.queue:
			if !ok {
				if !w.failed.Load() {
					w.fail(w.roll())
				}
				return
			}
			w.consume(d)
		case answer := <-w.seal:
			if w.failed.Load() {
				answer <- errors.New("trace writer failed")
				continue
			}
			// Flush completed calls already admitted before this management operation.
			for n := len(w.queue); n > 0; n-- {
				d := <-w.queue
				if d == nil {
					break
				}
				w.consume(d)
				if w.failed.Load() {
					break
				}
			}
			var err error
			if w.failed.Load() {
				err = errors.New("trace writer failed")
			} else {
				err = w.sealSegment()
				w.fail(err)
			}
			answer <- err
		case <-ticker.C:
			if !w.failed.Load() {
				w.fail(w.roll())
			}
		}
	}
}
func (r *Recorder) Seal(ctx context.Context) error {
	w := r.active.Load()
	if w == nil {
		return errors.New("trace archive disabled")
	}
	reply := make(chan error, 1)
	select {
	case w.seal <- reply:
	case <-ctx.Done():
		return ctx.Err()
	case <-w.done:
		return errors.New("trace archive stopped")
	}
	select {
	case err := <-reply:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

type Status struct {
	Enabled     bool       `json:"enabled"`
	Queue       int        `json:"queue_depth"`
	Dropped     uint64     `json:"dropped"`
	Calls       int64      `json:"today_calls"`
	Bytes       int64      `json:"today_bytes"`
	Ratio       float64    `json:"dedup_ratio"`
	Segments    []Manifest `json:"segments"`
	Error       string     `json:"last_error,omitempty"`
	UploadError string     `json:"last_upload_error,omitempty"`
}

func (r *Recorder) Status() Status {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := Status{Dropped: r.dropped.Load(), Error: r.lastError, Segments: []Manifest{}, Ratio: 1}
	var c counts
	if w := r.active.Load(); w != nil {
		s.Enabled = !w.failed.Load()
		s.Queue = len(w.queue)
		w.statusMu.Lock()
		if w.date == today() {
			c = w.live
		}
		s.Error = w.lastError
		s.UploadError = w.lastUpload
		w.statusMu.Unlock()
	}
	if dir := r.cfg.Dir; dir != "" {
		ms, err := listManifests(dir)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			s.Error = err.Error()
		}
		s.Segments = append(s.Segments, ms...)
		for _, m := range ms {
			if m.Date == today() {
				c.Calls += m.Counts.Calls
				c.Bytes += m.Counts.Bytes
				c.Unique += m.Counts.Unique
				c.Referenced += m.Counts.Referenced
			}
		}
	}
	s.Calls = c.Calls
	s.Bytes = c.Bytes
	s.Ratio = c.ratio()
	return s
}

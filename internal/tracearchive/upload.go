package tracearchive

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	log "github.com/sirupsen/logrus"
)

func (w *worker) maintain(ctx context.Context) {
	defer close(w.maintenanceDone)
	delay := time.Minute
	for {
		err := w.maintenance(ctx)
		w.statusMu.Lock()
		if err != nil {
			w.lastUpload = err.Error()
		} else {
			w.lastUpload = ""
		}
		w.statusMu.Unlock()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			log.WithError(err).Warn("trace archive maintenance failed")
		} else {
			delay = time.Minute
		}
		t := time.NewTimer(delay)
		if err != nil {
			delay = min(2*delay, time.Hour)
		}
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-w.wake:
			t.Stop()
		case <-t.C:
		}
	}
}
func (w *worker) maintenance(ctx context.Context) error {
	if err := recoverEvictions(w.cfg.Dir); err != nil {
		return err
	}
	ms, err := listManifests(w.cfg.Dir)
	if err != nil {
		return err
	}
	var first error
	for i, m := range ms {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if w.cfg.Upload.Enabled && m.UploadedTo != w.cfg.Upload.Remote && strings.HasSuffix(m.File, ".age") {
			if err = w.upload(ctx, &m); err != nil {
				first = err
				break
			}
			ms[i] = m
		}
	}
	if err = w.retain(ms); err != nil {
		return errors.Join(first, err)
	}
	return first
}

func (w *worker) upload(ctx context.Context, m *Manifest) error {
	cfg := w.cfg.Upload
	bin := cfg.Binary
	if bin == "" {
		bin = "rclone"
	}
	copyVerified := func(local, name, hash string, size int64) error {
		remote := strings.TrimRight(cfg.Remote, "/") + "/" + name
		if err := exec.CommandContext(ctx, bin, "copyto", "--", local, remote).Run(); err != nil {
			return fmt.Errorf("rclone copyto %s: %w", name, err)
		}
		cmd := exec.CommandContext(ctx, bin, "cat", "--", remote)
		h := sha256.New()
		count := &countWriter{w: h}
		cmd.Stdout = count
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("rclone verify %s: %w", name, err)
		}
		if count.n != size || fmt.Sprintf("%x", h.Sum(nil)) != hash {
			return fmt.Errorf("rclone verification mismatch for %s", name)
		}
		return nil
	}
	if err := copyVerified(filepath.Join(w.cfg.Dir, m.File), m.File, m.SHA256, m.Size); err != nil {
		return err
	}
	confirmed := *m
	confirmed.UploadedTo = cfg.Remote
	raw := confirmed.bytes()
	tmp, err := os.CreateTemp(w.cfg.Dir, ".trace-tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		if e := os.Remove(tmp.Name()); e != nil {
			log.WithError(e).Warn("trace manifest upload cleanup")
		}
	}()
	_, err = tmp.Write(raw)
	if e := tmp.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	if err = copyVerified(tmp.Name(), m.File+manifestSuffix, digest(raw), int64(len(raw))); err != nil {
		return err
	}
	if err = writeManifest(w.cfg.Dir, confirmed); err == nil {
		*m = confirmed
	}
	return err
}

type countWriter struct {
	w io.Writer
	n int64
}

func (c *countWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func recoverEvictions(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name, ok := strings.CutSuffix(e.Name(), ".evicting")
		if !ok {
			continue
		}
		m := segmentName.FindStringSubmatch(name)
		if m == nil || m[3] == "live" {
			continue
		}
		path := filepath.Join(dir, name)
		_, err = os.Stat(path + manifestSuffix)
		switch {
		case err == nil:
			if _, exists := os.Lstat(path); !errors.Is(exists, os.ErrNotExist) {
				return fmt.Errorf("cannot restore evicting segment %s", name)
			}
			err = os.Rename(path+".evicting", path)
		case errors.Is(err, os.ErrNotExist):
			err = os.Remove(path + ".evicting")
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (w *worker) retain(ms []Manifest) error {
	limit := w.cfg.MaxLocalSizeMB << 20
	if limit == 0 {
		return nil
	}
	entries, err := os.ReadDir(w.cfg.Dir)
	if err != nil {
		return err
	}
	var total int64
	for _, e := range entries {
		if segmentName.MatchString(strings.TrimSuffix(e.Name(), manifestSuffix)) {
			i, err := e.Info()
			if err != nil {
				return err
			}
			total += i.Size()
		}
	}
	for _, m := range ms {
		if total <= limit {
			break
		}
		if w.cfg.Upload.Enabled && m.UploadedTo != w.cfg.Upload.Remote {
			continue
		}
		path := filepath.Join(w.cfg.Dir, m.File)
		manifest := path + manifestSuffix
		sidecar, err := os.Stat(manifest)
		if err != nil {
			return err
		}
		// Keep the old data recoverable until the manifest removal commits.
		if err = os.Rename(path, path+".evicting"); err != nil {
			return err
		}
		if err = syncDirectory(w.cfg.Dir); err != nil {
			return err
		}
		if err = os.Remove(manifest); err != nil {
			return err
		}
		if err = syncDirectory(w.cfg.Dir); err != nil {
			return err
		}
		if err = os.Remove(path + ".evicting"); err != nil {
			return err
		}
		total -= m.Size + sidecar.Size()
	}
	if total > limit {
		log.WithField("bytes", total).Warn("trace archive exceeds local limit; remaining files are live or await verified upload")
	}
	return nil
}

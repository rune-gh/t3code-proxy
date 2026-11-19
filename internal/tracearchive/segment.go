package tracearchive

import (
	"bufio"
	"crypto/sha256"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"filippo.io/age"
	"github.com/MoeForge/moego/ojson"
	"github.com/klauspost/compress/zstd"
	"github.com/rune-oai/t3code-proxy/internal/config"
	log "github.com/sirupsen/logrus"
)

var segmentName = regexp.MustCompile(`^traces-(\d{4}-\d{2}-\d{2})(-\d+)?\.(live|jsonl\.zst(\.age)?)$`)

type counts struct {
	Calls      int64 `json:"calls"`
	Blobs      int64 `json:"blobs"`
	Unique     int64 `json:"unique_blob_bytes"`
	Referenced int64 `json:"referenced_blob_bytes"`
	Bytes      int64 `json:"jsonl_bytes"`
}

func (c counts) ratio() float64 {
	if c.Unique == 0 {
		return 1
	}
	return float64(c.Referenced) / float64(c.Unique)
}

type ledger struct {
	counts
	date  string
	sum   hash.Hash
	sizes map[string]int
}

func newLedger() *ledger           { return &ledger{sum: sha256.New(), sizes: make(map[string]int)} }
func (l *ledger) line(p []byte)    { _, _ = l.sum.Write(p); l.Bytes += int64(len(p)) }
func (l *ledger) checksum() string { return fmt.Sprintf("%x", l.sum.Sum(nil)) }

type segment struct {
	*ledger
	path string
	f    *os.File
}

func closeLogged(c io.Closer) {
	if err := c.Close(); err != nil {
		log.WithError(err).Error("trace archive close failed")
	}
}

func newSegment(dir, date string) (*segment, error) {
	path := filepath.Join(dir, fmt.Sprintf("traces-%s-%d.live", date, time.Now().UnixNano()))
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	s := &segment{newLedger(), path, f}
	s.date = date
	d := entry("header")
	_ = d.Set("schema_version", 1)
	_ = d.Set("date", date)
	if err = s.write(d.Bytes()); err == nil {
		err = syncDirectory(dir)
	}
	if err != nil {
		closeLogged(f)
		return nil, err
	}
	return s, nil
}
func (s *segment) write(data []byte) error {
	line := append(data, '\n')
	if _, err := s.f.Write(line); err != nil {
		return err
	}
	s.line(line)
	return nil
}
func (s *segment) append(d *call) error {
	var referenced int64
	data, err := d.encode(func(b []byte) (string, error) {
		h := digest(b)
		referenced += int64(len(b))
		if _, ok := s.sizes[h]; ok {
			return h, nil
		}
		e := entry("blob")
		_ = e.Set("sha256", h)
		_ = e.SetRawBytes("value", b)
		if err := s.write(e.Bytes()); err != nil {
			return "", err
		}
		s.sizes[h] = len(b)
		s.Unique += int64(len(b))
		s.Blobs++
		return h, nil
	})
	if err != nil {
		return err
	}
	if err = s.write(data); err != nil {
		return err
	}
	s.Calls++
	s.Referenced += referenced
	return s.f.Sync()
}

type visitor func([]byte) error

// ReadBytes handles large lines. An unterminated last line is recoverable only
// in a live segment. Complete invalid lines always signal corruption.
func scan(r io.Reader, date string, sealed bool, visit visitor) (*ledger, error) {
	l := newLedger()
	blobs := map[string][]byte{}
	reader := bufio.NewReader(r)
	footer := false
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			if !errors.Is(err, io.EOF) {
				return nil, err
			}
			if sealed && (!footer || len(line) > 0) {
				return nil, fmt.Errorf("missing footer or torn sealed tail")
			}
			break
		}
		if footer || !ojson.ValidBytes(line) {
			return nil, fmt.Errorf("invalid entry at byte %d", l.Bytes)
		}
		e := ojson.ParseBytes(line)
		typ := e.Get("type").String()
		if (l.Bytes == 0) != (typ == "header") {
			return nil, fmt.Errorf("misplaced or missing header")
		}
		switch typ {
		case "header":
			if e.Get("schema_version").Int() != 1 || e.Get("date").String() != date {
				return nil, fmt.Errorf("unsupported header or incorrect date")
			}
			l.date = date
		case "blob":
			v := e.Get("value")
			if !v.Exists() {
				return nil, fmt.Errorf("missing blob value")
			}
			b := canonical(nil, v)
			h := e.Get("sha256").String()
			if _, ok := l.sizes[h]; ok || digest(b) != h {
				return nil, fmt.Errorf("duplicate or invalid blob at %d", l.Bytes)
			}
			l.sizes[h] = len(b)
			if visit != nil {
				blobs[h] = b
			}
			l.Blobs++
			l.Unique += int64(len(b))
		case "call":
			c := e.Get("call")
			if c.Get("schema_version").Int() != 1 {
				return nil, fmt.Errorf("unsupported call schema")
			}
			var resolved *ojson.Doc
			if visit != nil {
				resolved = ojson.NewDocString(c.Raw)
			}
			for _, key := range []string{"client_request", "upstream_request"} {
				p := c.Get(key)
				if !p.Exists() {
					continue
				}
				for _, part := range p.Get("parts").Map() {
					for _, ref := range part.Array() {
						n, ok := l.sizes[ref.String()]
						if !ok {
							return nil, fmt.Errorf("missing reference at byte %d", l.Bytes)
						}
						l.Referenced += int64(n)
					}
				}
				if visit != nil {
					v, err := unpack(p, blobs)
					if err != nil {
						return nil, err
					}
					_ = resolved.SetRawBytes(key, v)
				}
			}
			if visit != nil {
				if err := visit(resolved.Bytes()); err != nil {
					return nil, err
				}
			}
			l.Calls++
		case "footer":
			if !sealed || e.Get("sha256").String() != l.checksum() || !sameCounts(e.Get("counts"), l.counts) {
				return nil, fmt.Errorf("invalid footer checksum or counts")
			}
			footer = true
			continue
		default:
			return nil, fmt.Errorf("unknown entry type at byte %d", l.Bytes)
		}
		l.line(line)
	}
	return l, nil
}
func sameCounts(r ojson.Result, c counts) bool {
	return r.Get("calls").Int() == c.Calls && r.Get("blobs").Int() == c.Blobs && r.Get("unique_blob_bytes").Int() == c.Unique && r.Get("referenced_blob_bytes").Int() == c.Referenced && r.Get("jsonl_bytes").Int() == c.Bytes
}
func recoverSegment(path, date string) (*segment, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	l, err := scan(f, date, false, nil)
	if err == nil {
		err = f.Truncate(l.Bytes)
	}
	if err == nil {
		_, err = f.Seek(0, io.SeekEnd)
	}
	if err != nil {
		closeLogged(f)
		return nil, err
	}
	s := &segment{l, path, f}
	if l.Bytes == 0 {
		l.date = date
		d := entry("header")
		_ = d.Set("schema_version", 1)
		_ = d.Set("date", date)
		if err = s.write(d.Bytes()); err != nil {
			closeLogged(f)
			return nil, err
		}
	}
	return s, nil
}

type Manifest struct {
	File         string `json:"file"`
	Date         string `json:"date"`
	Counts       counts `json:"counts"`
	Size         int64  `json:"size"`
	SHA256       string `json:"sha256"`
	SourceSHA256 string `json:"source_sha256"`
	UploadedTo   string `json:"uploaded_to,omitempty"`
}

func (m Manifest) bytes() []byte {
	d := object()
	_ = d.Set("manifest", m)
	return append([]byte(d.Get("manifest").Raw), '\n')
}
func fileHash(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer closeLogged(f)
	h := sha256.New()
	n, err := io.Copy(h, f)
	return fmt.Sprintf("%x", h.Sum(nil)), n, err
}

func atomicFile(path string, write func(*os.File) error) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".trace-tmp-*")
	if err != nil {
		return err
	}
	defer func() {
		if e := os.Remove(tmp.Name()); e != nil && !errors.Is(e, os.ErrNotExist) {
			log.WithError(e).Warn("trace archive temporary file cleanup")
		}
	}()
	err = write(tmp)
	if err == nil {
		err = tmp.Sync()
	}
	if e := tmp.Close(); err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	if err = os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
func syncDirectory(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer closeLogged(f)
	return f.Sync()
}
func writeManifest(dir string, m Manifest) error {
	return atomicFile(filepath.Join(dir, m.File+".manifest.json"), func(f *os.File) error { _, err := f.Write(m.bytes()); return err })
}

func (s *segment) seal(cfg config.TraceArchiveConfig) error {
	if err := s.f.Sync(); err != nil {
		return err
	}
	target := strings.TrimSuffix(s.path, ".live") + ".jsonl.zst"
	var keys []age.Recipient
	for _, key := range cfg.Recipients {
		k, err := age.ParseX25519Recipient(key)
		if err != nil {
			return fmt.Errorf("invalid archive recipient")
		}
		keys = append(keys, k)
	}
	if len(keys) > 0 {
		target += ".age"
	} else {
		log.Warn("sealing plaintext trace archive: no age recipients configured")
	}
	footer := entry("footer")
	_ = footer.Set("counts", s.counts)
	_ = footer.Set("sha256", s.checksum())
	if err := atomicFile(target, func(f *os.File) error {
		var out io.Writer = f
		var enc io.WriteCloser
		if len(keys) > 0 {
			var err error
			enc, err = age.Encrypt(f, keys...)
			if err != nil {
				return err
			}
			out = enc
		}
		z, err := zstd.NewWriter(out, zstd.WithEncoderConcurrency(1))
		if err != nil {
			return err
		}
		if _, err = s.f.Seek(0, io.SeekStart); err == nil {
			_, err = io.Copy(z, s.f)
		}
		if err == nil {
			_, err = z.Write(append(footer.Bytes(), '\n'))
		}
		if e := z.Close(); err == nil {
			err = e
		}
		if enc != nil {
			if e := enc.Close(); err == nil {
				err = e
			}
		}
		return err
	}); err != nil {
		return err
	}
	h, size, err := fileHash(target)
	if err != nil {
		return err
	}
	m := Manifest{File: filepath.Base(target), Date: s.date, Counts: s.counts, Size: size, SHA256: h, SourceSHA256: s.checksum()}
	if err = writeManifest(filepath.Dir(target), m); err != nil {
		return err
	}
	if err = s.f.Close(); err != nil {
		return err
	}
	s.f = nil
	return os.Remove(s.path)
}

func listManifests(dir string) ([]Manifest, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []Manifest
	for _, e := range entries {
		file, ok := strings.CutSuffix(e.Name(), ".manifest.json")
		if !ok {
			continue
		}
		match := segmentName.FindStringSubmatch(file)
		if match == nil || match[3] == "live" {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		r := ojson.ParseBytes(b)
		if !ojson.ValidBytes(b) || r.Get("file").String() != file || r.Get("date").String() != match[1] || len(r.Get("sha256").String()) != 64 {
			return nil, fmt.Errorf("invalid manifest %s", e.Name())
		}
		c := r.Get("counts")
		m := Manifest{File: file, Date: match[1], Counts: counts{c.Get("calls").Int(), c.Get("blobs").Int(), c.Get("unique_blob_bytes").Int(), c.Get("referenced_blob_bytes").Int(), c.Get("jsonl_bytes").Int()}, Size: r.Get("size").Int(), SHA256: r.Get("sha256").String(), SourceSHA256: r.Get("source_sha256").String(), UploadedTo: r.Get("uploaded_to").String()}
		out = append(out, m)
	}
	return out, nil
}

func validDate(s string) bool {
	_, err := time.Parse(time.DateOnly, s)
	return err == nil && len(s) == len(time.DateOnly)
}

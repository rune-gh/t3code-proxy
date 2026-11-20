package tracearchive

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"filippo.io/age"
	"github.com/MoeForge/moego/ojson"
	"github.com/klauspost/compress/zstd"
	"github.com/rune-oai/t3code-proxy/internal/config"
)

func Main(args []string, out, stderr io.Writer) int {
	if err := command(args, out, stderr); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintln(stderr, "traces:", err)
		return 1
	}
	return 0
}
func command(args []string, out, stderr io.Writer) error {
	if len(args) == 0 || (args[0] != "export" && args[0] != "verify" && args[0] != "stats") {
		return fmt.Errorf("usage: traces {export|verify|stats} [--dir PATH] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--identity FILE]")
	}
	mode := args[0]
	fs := flag.NewFlagSet("traces "+mode, flag.ContinueOnError)
	fs.SetOutput(stderr)
	dir := fs.String("dir", "", "archive directory")
	cfgPath := fs.String("config", "config.yaml", "hub config to resolve archive directory")
	from := fs.String("from", "", "first UTC segment date (inclusive)")
	to := fs.String("to", "", "last UTC segment date (inclusive)")
	identity := fs.String("identity", "", "age identity file")
	format := fs.String("format", "calls", "calls or conversations")
	output := fs.String("output", "", "write to a new file (default stdout)")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}
	if fs.NArg() != 0 || (*from != "" && !validDate(*from)) || (*to != "" && !validDate(*to)) || (*to != "" && *from > *to) || (*format != "calls" && *format != "conversations") {
		return errors.New("invalid arguments or UTC date range")
	}
	if *dir == "" {
		cfg := &config.Config{}
		b, err := os.ReadFile(*cfgPath)
		if err == nil {
			cfg, err = config.ParseConfigBytes(b)
		} else if errors.Is(err, os.ErrNotExist) && *cfgPath == "config.yaml" {
			err = nil
		}
		if err != nil {
			return err
		}
		*dir, err = Directory(cfg)
		if err != nil {
			return err
		}
	}
	var ids []age.Identity
	if *identity != "" {
		b, err := os.ReadFile(*identity)
		if err != nil {
			return err
		}
		ids, err = age.ParseIdentities(bytes.NewReader(b))
		if err != nil {
			return errors.New("invalid age identity file")
		}
	}
	if *output != "" {
		f, err := os.OpenFile(*output, os.O_WRONLY|os.O_EXCL|os.O_CREATE, 0600)
		if err != nil {
			return err
		}
		err = readArchive(*dir, *from, *to, mode, *format, ids, f)
		if e := f.Close(); err == nil {
			err = e
		}
		if err != nil {
			if e := os.Remove(*output); e != nil {
				return errors.Join(err, e)
			}
		}
		return err
	}
	return readArchive(*dir, *from, *to, mode, *format, ids, out)
}

func readArchive(dir, from, to, mode, format string, ids []age.Identity, out io.Writer) error {
	manifests, err := listManifests(dir)
	if err != nil {
		return err
	}
	ms := map[string]Manifest{}
	for _, m := range manifests {
		ms[m.File] = m
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	groups := make(map[string][][]byte)
	var visit visitor
	if mode == "export" {
		visit = func(b []byte) error {
			if format == "calls" {
				_, err := out.Write(append(b, '\n'))
				return err
			}
			key := ojson.GetBytesNoCopy(b, "session_id").String()
			if key == "" {
				key = ojson.GetBytesNoCopy(b, "request_id").String()
			}
			groups[key] = append(groups[key], b)
			return nil
		}
	}
	for _, e := range entries {
		m := segmentName.FindStringSubmatch(e.Name())
		if m == nil || (from != "" && m[1] < from) || (to != "" && m[1] > to) {
			continue
		}
		manifest, ok := ms[e.Name()]
		sealed := m[3] != "live"
		if sealed && !ok {
			return fmt.Errorf("%s: missing manifest", e.Name())
		}
		delete(ms, e.Name())
		c := manifest.Counts
		if mode != "stats" || !sealed {
			l, err := readSegment(filepath.Join(dir, e.Name()), m[1], sealed, manifest, ids, visit)
			if err != nil {
				return fmt.Errorf("%s: %w", e.Name(), err)
			}
			c = l.counts
		}
		switch mode {
		case "verify":
			if _, err = fmt.Fprintf(out, "ok %s (%d calls, %d blobs)\n", e.Name(), c.Calls, c.Blobs); err != nil {
				return err
			}
		case "stats":
			d := object()
			_ = d.Set("file", e.Name())
			_ = d.Set("counts", c)
			_ = d.Set("dedup_ratio", c.ratio())
			_, err = out.Write(append(d.Bytes(), '\n'))
			if err != nil {
				return err
			}
		}
	}
	for _, m := range ms {
		if (from == "" || m.Date >= from) && (to == "" || m.Date <= to) {
			return fmt.Errorf("%s: manifest has no segment", m.File)
		}
	}
	for _, key := range sortedKeys(groups) {
		d := object()
		_ = d.Set("session_id", ojson.GetBytesNoCopy(groups[key][0], "session_id").String())
		_ = d.SetRawBytes("calls", append(append([]byte{'['}, bytes.Join(groups[key], []byte(","))...), ']'))
		if _, err = out.Write(append(d.Bytes(), '\n')); err != nil {
			return err
		}
	}
	return nil
}

func readSegment(path, date string, sealed bool, m Manifest, ids []age.Identity, visit visitor) (*ledger, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer closeLogged(f)
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var r io.Reader = io.LimitReader(f, info.Size())
	if sealed {
		h, n, err := fileHash(path)
		if err != nil {
			return nil, err
		}
		if h != m.SHA256 || n != m.Size {
			return nil, errors.New("sealed file does not match manifest")
		}
		if strings.HasSuffix(path, ".age") {
			if len(ids) == 0 {
				return nil, errors.New("--identity required")
			}
			r, err = age.Decrypt(r, ids...)
			if err != nil {
				return nil, err
			}
		}
		z, err := zstd.NewReader(r, zstd.WithDecoderConcurrency(1))
		if err != nil {
			return nil, err
		}
		defer z.Close()
		r = z
	}
	l, err := scan(r, date, sealed, visit)
	if err == nil && sealed && (m.SourceSHA256 != l.checksum() || m.Counts != l.counts) {
		return nil, errors.New("manifest counts or source hash mismatch")
	}
	return l, err
}

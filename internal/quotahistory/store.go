package quotahistory

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"go.etcd.io/bbolt"
)

var (
	samplesBucket          = []byte("samples")
	mistralCustomersBucket = []byte("mistral_customers")
)

const boltOpenTimeout = 2 * time.Second

// Sample is one poll result for one credential.
type Sample struct {
	T         int64             `json:"t"`
	AuthIndex string            `json:"auth_index"`
	Windows   map[string]Window `json:"windows"`
	Error     string            `json:"error"`
}

// record is the persisted form of a sample. Plan is kept so the account list
// can report a plan after a restart.
type record struct {
	Sample
	Plan string `json:"plan,omitempty"`
}

// Store persists samples in bbolt. Keys are an 8-byte big-endian unix-ms
// timestamp followed by the auth index, so a time-range query is one cursor
// seek plus a forward scan, and pruning deletes a key prefix range.
type Store struct {
	db *bbolt.DB
}

// OpenStore opens (or creates) the database at path.
func OpenStore(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if errMkdir := os.MkdirAll(dir, 0o700); errMkdir != nil {
			return nil, fmt.Errorf("quota-history: create directory: %w", errMkdir)
		}
	}
	db, errOpen := bbolt.Open(path, 0o600, &bbolt.Options{Timeout: boltOpenTimeout})
	if errOpen != nil {
		return nil, fmt.Errorf("quota-history: open %s: %w", path, errOpen)
	}
	errInit := db.Update(func(tx *bbolt.Tx) error {
		_, errCreate := tx.CreateBucketIfNotExists(samplesBucket)
		return errCreate
	})
	if errInit != nil {
		_ = db.Close()
		return nil, fmt.Errorf("quota-history: init %s: %w", path, errInit)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func sampleKey(t int64, authIndex string) []byte {
	key := binary.BigEndian.AppendUint64(make([]byte, 0, 8+len(authIndex)), uint64(t))
	return append(key, authIndex...)
}

func timeKey(t int64) []byte {
	if t < 0 {
		t = 0
	}
	key := make([]byte, 8)
	binary.BigEndian.PutUint64(key, uint64(t))
	return key
}

func (s *Store) put(rec record) error {
	if rec.Windows == nil {
		rec.Windows = map[string]Window{}
	}
	value, errMarshal := json.Marshal(rec)
	if errMarshal != nil {
		return errMarshal
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		return tx.Bucket(samplesBucket).Put(sampleKey(rec.T, rec.AuthIndex), value)
	})
}

// scan calls fn for every record with since <= t <= until in time order.
func (s *Store) scan(since, until int64, fn func(record)) error {
	return s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(samplesBucket).Cursor()
		limit := timeKey(until + 1)
		for k, v := c.Seek(timeKey(since)); k != nil && bytes.Compare(k[:min(8, len(k))], limit) < 0; k, v = c.Next() {
			var rec record
			if errUnmarshal := json.Unmarshal(v, &rec); errUnmarshal != nil {
				continue
			}
			fn(rec)
		}
		return nil
	})
}

// lastTime returns the newest sample timestamp, or 0 when empty.
func (s *Store) lastTime() int64 {
	var last int64
	_ = s.db.View(func(tx *bbolt.Tx) error {
		k, _ := tx.Bucket(samplesBucket).Cursor().Last()
		if len(k) >= 8 {
			last = int64(binary.BigEndian.Uint64(k[:8]))
		}
		return nil
	})
	return last
}

// latestPlans returns the newest non-empty plan per auth index, looking at no
// more than maxRecords of the most recent samples.
func (s *Store) latestPlans(maxRecords int) map[string]string {
	plans := make(map[string]string)
	_ = s.db.View(func(tx *bbolt.Tx) error {
		c := tx.Bucket(samplesBucket).Cursor()
		seen := 0
		for k, v := c.Last(); k != nil && seen < maxRecords; k, v = c.Prev() {
			seen++
			var rec record
			if errUnmarshal := json.Unmarshal(v, &rec); errUnmarshal != nil || rec.Plan == "" {
				continue
			}
			if _, known := plans[rec.AuthIndex]; !known {
				plans[rec.AuthIndex] = rec.Plan
			}
		}
		return nil
	})
	return plans
}

func (s *Store) putMistralCustomers(customers map[string]string) error {
	if len(customers) == 0 {
		return nil
	}
	return s.db.Update(func(tx *bbolt.Tx) error {
		bucket, errCreate := tx.CreateBucketIfNotExists(mistralCustomersBucket)
		if errCreate != nil {
			return errCreate
		}
		for index, customer := range customers {
			key := []byte(index)
			if string(bucket.Get(key)) == customer {
				continue
			}
			if errPut := bucket.Put(key, []byte(customer)); errPut != nil {
				return errPut
			}
		}
		return nil
	})
}

func (s *Store) mistralCustomers() (map[string]string, error) {
	customers := make(map[string]string)
	errView := s.db.View(func(tx *bbolt.Tx) error {
		bucket := tx.Bucket(mistralCustomersBucket)
		if bucket == nil {
			return nil
		}
		return bucket.ForEach(func(index, customer []byte) error {
			customers[string(index)] = string(customer)
			return nil
		})
	})
	return customers, errView
}

// prune deletes samples older than before (unix ms) and returns the count.
func (s *Store) prune(before int64) (int, error) {
	deleted := 0
	limit := timeKey(before)
	errUpdate := s.db.Update(func(tx *bbolt.Tx) error {
		bucket := tx.Bucket(samplesBucket)
		// Collect first: deleting through the cursor while iterating skips keys.
		var keys [][]byte
		c := bucket.Cursor()
		for k, _ := c.First(); k != nil && bytes.Compare(k[:min(8, len(k))], limit) < 0; k, _ = c.Next() {
			keys = append(keys, append([]byte(nil), k...))
		}
		for _, k := range keys {
			if errDelete := bucket.Delete(k); errDelete != nil {
				return errDelete
			}
		}
		deleted = len(keys)
		return nil
	})
	if errUpdate != nil {
		return 0, errUpdate
	}
	return deleted, nil
}

package quotahistory

import (
	"path/filepath"
	"reflect"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, errOpen := OpenStore(filepath.Join(t.TempDir(), "nested", "qh.db"))
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func collect(t *testing.T, store *Store, since, until int64) []record {
	t.Helper()
	var out []record
	if errScan := store.scan(since, until, func(rec record) { out = append(out, rec) }); errScan != nil {
		t.Fatal(errScan)
	}
	return out
}

func TestStoreRoundTripRangeAndPrune(t *testing.T) {
	store := openTestStore(t)
	reset := int64(1731900000000)
	first := record{
		Sample: Sample{T: 1000, AuthIndex: "b", Windows: map[string]Window{
			WindowSevenDay: {UsedPercent: 40, ResetsAt: &reset, PeriodHours: 168},
		}},
		Plan: "max_20x",
	}
	recs := []record{
		first,
		{Sample: Sample{T: 1000, AuthIndex: "a", Error: "HTTP 401"}},
		{Sample: Sample{T: 2000, AuthIndex: "a", Windows: map[string]Window{WindowFiveHour: {UsedPercent: 1, PeriodHours: 5}}}},
		{Sample: Sample{T: 3000, AuthIndex: "b"}, Plan: "max_5x"},
	}
	for _, rec := range recs {
		if errPut := store.put(rec); errPut != nil {
			t.Fatal(errPut)
		}
	}

	all := collect(t, store, 0, 10000)
	if len(all) != 4 {
		t.Fatalf("got %d records", len(all))
	}
	// Ordered by time, then auth index.
	if all[0].AuthIndex != "a" || all[1].AuthIndex != "b" || all[2].T != 2000 || all[3].T != 3000 {
		t.Fatalf("unexpected order: %+v", all)
	}
	if !reflect.DeepEqual(all[1], first) {
		t.Fatalf("round trip mismatch:\n got %+v\nwant %+v", all[1], first)
	}
	if all[0].Error != "HTTP 401" || len(all[0].Windows) != 0 || all[0].Windows == nil {
		t.Fatalf("error sample not preserved: %+v", all[0])
	}

	// Range bounds are inclusive.
	if got := collect(t, store, 2000, 3000); len(got) != 2 {
		t.Fatalf("range [2000,3000] returned %d", len(got))
	}
	if got := collect(t, store, 1001, 1999); len(got) != 0 {
		t.Fatalf("empty range returned %d", len(got))
	}
	if store.lastTime() != 3000 {
		t.Fatalf("lastTime = %d", store.lastTime())
	}
	if plans := store.latestPlans(100); plans["b"] != "max_5x" || len(plans) != 1 {
		t.Fatalf("latestPlans = %+v", plans)
	}

	n, errPrune := store.prune(2000)
	if errPrune != nil || n != 2 {
		t.Fatalf("prune = %d, %v", n, errPrune)
	}
	left := collect(t, store, 0, 10000)
	if len(left) != 2 || left[0].T != 2000 {
		t.Fatalf("after prune: %+v", left)
	}
}

func TestStoreReopenKeepsData(t *testing.T) {
	path := filepath.Join(t.TempDir(), "qh.db")
	store, errOpen := OpenStore(path)
	if errOpen != nil {
		t.Fatal(errOpen)
	}
	if errPut := store.put(record{Sample: Sample{T: 5, AuthIndex: "x"}}); errPut != nil {
		t.Fatal(errPut)
	}
	if errClose := store.Close(); errClose != nil {
		t.Fatal(errClose)
	}
	reopened, errReopen := OpenStore(path)
	if errReopen != nil {
		t.Fatal(errReopen)
	}
	defer func() { _ = reopened.Close() }()
	if got := collect(t, reopened, 0, 10); len(got) != 1 || got[0].AuthIndex != "x" {
		t.Fatalf("reopened data: %+v", got)
	}
}

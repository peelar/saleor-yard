package yardd

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStatusStoreDefaultsToRequested(t *testing.T) {
	t.Parallel()
	store := NewStatusStore(filepath.Join(t.TempDir(), "status.json"))

	status, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "requested" || status.Phase != "requested" {
		t.Fatalf("unexpected default status: %#v", status)
	}
}

func TestStatusStoreKeepsLiveStatusWhenDiskWriteFails(t *testing.T) {
	t.Parallel()
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, []byte("blocked"), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStatusStore(filepath.Join(blocker, "status.json"))
	want := NewStatus("failed", "building_core", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "disk full")

	if err := store.Write(want); err == nil {
		t.Fatal("expected persistence to fail")
	}
	got, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("status mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

func TestStatusStoreRoundTrip(t *testing.T) {
	t.Parallel()
	store := NewStatusStore(filepath.Join(t.TempDir(), "nested", "status.json"))
	want := NewStatus("provisioning", "building_core", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "")

	if err := store.Write(want); err != nil {
		t.Fatal(err)
	}
	got, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("status mismatch\nwant: %#v\n got: %#v", want, got)
	}
}

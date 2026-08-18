package factoryd

import (
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

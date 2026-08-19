package yardd

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type StatusStore struct {
	path string
	mu   sync.RWMutex
	live *Status
}

func NewStatusStore(path string) *StatusStore {
	return &StatusStore{path: path}
}

func (s *StatusStore) Read() (Status, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.live != nil {
		status := *s.live
		return status, nil
	}

	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return NewStatus("requested", "requested", "", ""), nil
	}
	if err != nil {
		return Status{}, err
	}

	var status Status
	if err := json.Unmarshal(data, &status); err != nil {
		return Status{}, err
	}
	return status, nil
}

func (s *StatusStore) Write(status Status) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Keep serving the live state even when the disk cannot persist it.
	// This lets the controller see a failure caused by a full disk.
	s.live = &status

	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	temporary := s.path + ".tmp"
	if err := os.WriteFile(temporary, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, s.path)
}

package factoryd

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
}

func NewStatusStore(path string) *StatusStore {
	return &StatusStore{path: path}
}

func (s *StatusStore) Read() (Status, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

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

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

func privateWrite(path string, data []byte) (err error) {
	file, err := os.CreateTemp(filepath.Dir(path), ".aistudio-state-*")
	if err != nil { return err }
	name := file.Name()
	defer func() {
		if removeErr := os.Remove(name); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			slog.Warn("AI Studio temporary state cleanup failed", "error", removeErr)
		}
	}()
	if _, err := file.Write(data); err != nil { return errors.Join(err, file.Close()) }
	if err := file.Sync(); err != nil { return errors.Join(err, file.Close()) }
	if err := file.Close(); err != nil { return err }
	if err := os.Rename(name, path); err != nil { return err }
	return nil
}

func (entry *account) persist(ctx context.Context) error {
	cookies, err := entry.worker.StorageCookies(ctx)
	if err != nil { return fmt.Errorf("export account cookies: %w", err) }
	path := filepath.Join(entry.directory, "storage-state.json")
	data, err := os.ReadFile(path)
	if err != nil { return err }
	// Replace only cookies; retain origins/localStorage and every extension field.
	var state map[string]json.RawMessage
	if err := json.Unmarshal(data, &state); err != nil { return err }
	if state == nil { return fmt.Errorf("%w: storage state must be an object", errProtocol) }
	state["cookies"] = cookies
	encoded, err := json.Marshal(state)
	if err != nil { return err }
	return privateWrite(path, encoded)
}

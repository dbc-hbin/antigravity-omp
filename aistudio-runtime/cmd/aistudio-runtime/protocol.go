package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

var errProtocol = errors.New("invalid aistudio runtime command")

type command struct {
	ID string `json:"id"`
	Method string `json:"method"`
	Directory string `json:"directory"`
	Model string `json:"model"`
	Proxy string `json:"proxy"`
	Locale string `json:"locale"`
	Timezone string `json:"timezone"`
	Body json.RawMessage `json:"body"`
	Prompt string `json:"prompt"`
	Tier *int `json:"tier"`
	Target string `json:"target"`
}

type event struct {
	ID string `json:"id"`
	Event string `json:"event"`
	Data json.RawMessage `json:"data,omitempty"`
	Message string `json:"message,omitempty"`
	Status int `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type output struct {
	mu sync.Mutex
	writer io.Writer
}

func (out *output) send(value event) error {
	out.mu.Lock()
	defer out.mu.Unlock()
	return json.NewEncoder(out.writer).Encode(value)
}

func parseCommand(line []byte) (command, error) {
	var value command
	if err := json.Unmarshal(line, &value); err != nil {
		return value, fmt.Errorf("%w: %w", errProtocol, err)
	}
	if value.ID == "" {
		return value, fmt.Errorf("%w: id is required", errProtocol)
	}
	switch value.Method {
	case "login", "catalog":
		if value.Directory == "" {
			return value, fmt.Errorf("%w: directory is required", errProtocol)
		}
	case "generate":
		var fields []json.RawMessage
		if value.Directory == "" || value.Model == "" {
			return value, fmt.Errorf("%w: directory and model are required", errProtocol)
		}
		if err := json.Unmarshal(value.Body, &fields); err != nil {
			return value, fmt.Errorf("%w: body must be an array: %w", errProtocol, err)
		}
		if len(fields) < 5 || !bytes.Equal(bytes.TrimSpace(fields[4]), []byte("null")) {
			return value, fmt.Errorf("%w: body slot 4 must be null", errProtocol)
		}
		var model string
		if err := json.Unmarshal(fields[0], &model); err != nil || model != value.Model && model != "models/"+value.Model {
			return value, fmt.Errorf("%w: body model differs from requested model", errProtocol)
		}
	case "cancel":
		if value.Target == "" {
			return value, fmt.Errorf("%w: cancel target is required", errProtocol)
		}
	case "close":
	default:
		return value, fmt.Errorf("%w: unknown method %q", errProtocol, value.Method)
	}
	return value, nil
}

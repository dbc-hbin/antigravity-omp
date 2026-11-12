package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/omp/aistudio-runtime/internal/camoufoxnative"
)

type account struct {
	directory string
	gate chan struct{}
	worker *camoufoxnative.Worker
	model string
}

type accountEnvironment struct {
	Proxy string `json:"proxy"`
	Locale string `json:"locale"`
	Timezone string `json:"timezone"`
}

func (entry *account) execute(ctx context.Context, request command, out *output) (err error) {
	if err := ctx.Err(); err != nil { return err }
	if err := os.MkdirAll(entry.directory, 0o700); err != nil { return err }
	if err := os.Chmod(entry.directory, 0o700); err != nil { return err }
	if request.Method == "login" {
		return entry.login(ctx, request, out)
	}
	environment, err := entry.environment(request)
	if err != nil { return err }
	model := ""
	if request.Method == "generate" { model = strings.TrimPrefix(request.Model, "models/") }
	if entry.worker != nil && model != "" && entry.model != model {
		if err := entry.close(); err != nil { return err }
	}
	if entry.worker == nil {
		if err := out.send(event{ID: request.ID, Event: "progress", Message: "Preparing native Camoufox runtime"}); err != nil { return err }
		executable, err := camoufoxnative.FindExecutable(ctx, environment.Proxy)
		if err != nil { return err }
		worker, err := camoufoxnative.Start(ctx, camoufoxnative.Options{
			ExecutablePath: executable, StorageStatePath: filepath.Join(entry.directory, "storage-state.json"),
			Model: model, Locale: environment.Locale, Timezone: environment.Timezone, Proxy: environment.Proxy,
			Headless: true, ReadyTimeout: 2*time.Minute, Log: os.Stderr,
		})
		if err != nil { return err }
		entry.worker, entry.model = worker, model
	}
	switch request.Method {
	case "catalog":
		catalog := entry.worker.PageCatalog()
		models, err := catalogArray(catalog.Models)
		if err != nil { return fmt.Errorf("ListModels: %w", err) }
		tier, err := catalogArray(catalog.Tier)
		if err != nil { return fmt.Errorf("GetAiStudioBenefitTier: %w", err) }
		data, err := json.Marshal(struct {
			Models json.RawMessage `json:"models"`
			Tier json.RawMessage `json:"tier"`
		}{models, tier})
		if err != nil { return err }
		if err := entry.persist(ctx); err != nil { return err }
		return out.send(event{ID: request.ID, Event: "result", Data: data})
	case "generate":
		generateErr := entry.generate(ctx, request, out)
		persistCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := errors.Join(generateErr, entry.persist(persistCtx)); err != nil { return err }
		return out.send(event{ID: request.ID, Event: "end"})
	default:
		return fmt.Errorf("%w: unsupported account operation", errProtocol)
	}
}

func (entry *account) environment(request command) (accountEnvironment, error) {
	environment := accountEnvironment{Locale: "en-US", Timezone: "UTC"}
	encoded, err := os.ReadFile(filepath.Join(entry.directory, "environment.json"))
	if err != nil && !errors.Is(err, os.ErrNotExist) { return environment, err }
	if err == nil {
		if err := json.Unmarshal(encoded, &environment); err != nil { return environment, err }
	}
	if request.Method != "login" && encoded != nil {
		if request.Proxy != "" && request.Proxy != environment.Proxy || request.Locale != "" && request.Locale != environment.Locale || request.Timezone != "" && request.Timezone != environment.Timezone {
			return environment, fmt.Errorf("%w: account environment differs from login; log in again with the new environment", errProtocol)
		}
		return environment, nil
	}
	if request.Proxy != "" { environment.Proxy = request.Proxy }
	if request.Locale != "" { environment.Locale = request.Locale }
	if request.Timezone != "" { environment.Timezone = request.Timezone }
	if _, err := time.LoadLocation(environment.Timezone); err != nil { return environment, fmt.Errorf("account timezone: %w", err) }
	return environment, nil
}

func (entry *account) login(ctx context.Context, request command, out *output) error {
	environment, err := entry.environment(request)
	if err != nil { return err }
	if err := entry.close(); err != nil { return err }
	if err := out.send(event{ID: request.ID, Event: "progress", Message: "Downloading or locating Camoufox, then opening Google login"}); err != nil { return err }
	executable, err := camoufoxnative.FindExecutable(ctx, environment.Proxy)
	if err != nil { return err }
	result, err := camoufoxnative.Login(ctx, camoufoxnative.LoginOptions{
		ExecutablePath: executable, Directory: entry.directory, Locale: environment.Locale,
		Timezone: environment.Timezone, Proxy: environment.Proxy, Timeout: 30*time.Minute, Log: os.Stderr,
	})
	if err != nil { return err }
	if err := privateWrite(filepath.Join(entry.directory, "storage-state.json"), result.StorageStateJSON); err != nil { return err }
	encoded, err := json.Marshal(environment)
	if err != nil { return err }
	if err := privateWrite(filepath.Join(entry.directory, "environment.json"), encoded); err != nil { return err }
	if result.CloseError != "" { return fmt.Errorf("login browser shutdown: %s", result.CloseError) }
	data, err := json.Marshal(struct {
		Directory string `json:"directory"`
		Email string `json:"email"`
	}{entry.directory, result.Email})
	if err != nil { return err }
	return out.send(event{ID: request.ID, Event: "result", Data: data})
}

func (entry *account) close() error {
	if entry.worker == nil { return nil }
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	persistErr := entry.persist(ctx)
	closeErr := entry.worker.Close()
	entry.worker, entry.model = nil, ""
	return errors.Join(persistErr, closeErr)
}

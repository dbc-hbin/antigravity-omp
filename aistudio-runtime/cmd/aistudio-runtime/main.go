package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/omp/aistudio-runtime/internal/camoufoxnative"
)

type runtimeServer struct {
	out output
	mu sync.Mutex
	active map[string]context.CancelFunc
	accounts map[string]*account
	jobs sync.WaitGroup
}

type inputLine struct {
	bytes []byte
	err error
}

func main() {
	if err := run(); err != nil {
		slog.Error("AI Studio runtime stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := runtimeServer{out: output{writer: os.Stdout}, active: make(map[string]context.CancelFunc), accounts: make(map[string]*account)}
	lines := make(chan inputLine)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 64*1024*1024)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- inputLine{bytes: line}:
			case <-ctx.Done(): return
			}
		}
		if err := scanner.Err(); err != nil {
			select {
			case lines <- inputLine{err: err}:
			case <-ctx.Done():
			}
		}
	}()
	var closeID string
	var inputErr error
readLoop:
	for {
		select {
		case <-ctx.Done(): break readLoop
		case line, open := <-lines:
			if !open { break readLoop }
			if line.err != nil { inputErr = line.err; break readLoop }
			request, err := parseCommand(line.bytes)
			if err != nil {
				if sendErr := server.failure(request.ID, err); sendErr != nil { inputErr = sendErr; break readLoop }
				continue
			}
			switch request.Method {
			case "close": closeID = request.ID; break readLoop
			case "cancel":
				server.mu.Lock()
				stop := server.active[request.Target]
				server.mu.Unlock()
				if stop != nil { stop() }
			case "login", "catalog", "generate":
				if err := server.dispatch(ctx, request); err != nil {
					if sendErr := server.failure(request.ID, err); sendErr != nil { inputErr = sendErr; break readLoop }
				}
			}
		}
	}
	cancel()
	server.jobs.Wait()
	var closeErrors []error
	for _, account := range server.accounts {
		closeErrors = append(closeErrors, account.close())
	}
	shutdownErr := errors.Join(append(closeErrors, inputErr)...)
	if closeID != "" {
		if shutdownErr != nil { return errors.Join(shutdownErr, server.failure(closeID, shutdownErr)) }
		return server.out.send(event{ID: closeID, Event: "result", Data: []byte("null")})
	}
	return shutdownErr
}

func (server *runtimeServer) dispatch(ctx context.Context, request command) error {
	directory, err := filepath.Abs(request.Directory)
	if err != nil { return fmt.Errorf("resolve account directory: %w", err) }
	request.Directory = directory
	server.mu.Lock()
	defer server.mu.Unlock()
	if _, exists := server.active[request.ID]; exists { return fmt.Errorf("%w: duplicate active id", errProtocol) }
	entry := server.accounts[directory]
	if entry == nil {
		entry = &account{directory: directory, gate: make(chan struct{}, 1)}
		server.accounts[directory] = entry
	}
	jobCtx, stop := context.WithCancel(ctx)
	server.active[request.ID] = stop
	server.jobs.Go(func() {
		defer stop()
		defer func() { server.mu.Lock(); delete(server.active, request.ID); server.mu.Unlock() }()
		var err error
		select {
		case entry.gate <- struct{}{}:
			err = entry.execute(jobCtx, request, &server.out)
			<-entry.gate
		case <-jobCtx.Done(): err = jobCtx.Err()
		}
		if err != nil {
			if sendErr := server.failure(request.ID, err); sendErr != nil {
				slog.Error("AI Studio protocol write failed", "error", sendErr)
			}
		}
	})
	return nil
}

func (server *runtimeServer) failure(id string, err error) error {
	status := 0
	if errors.Is(err, errProtocol) { status = 400 }
	if errors.Is(err, camoufoxnative.ErrAuthenticationRequired) { status = 401 }
	if errors.Is(err, camoufoxnative.ErrRegionNotSupported) { status = 403 }
	return server.out.send(event{ID: id, Event: "error", Message: err.Error(), Status: status})
}

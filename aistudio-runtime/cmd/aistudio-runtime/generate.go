package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/omp/aistudio-runtime/internal/camoufoxnative"
)

const generateURL = "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent"

func (entry *account) generate(ctx context.Context, request command, out *output) (err error) {
	start, end, err := arrayElementSpan(request.Body, 4)
	if err != nil { return err }
	tier, err := entry.benefitTier()
	if err != nil { return err }
	if request.Tier != nil && *request.Tier != tier { return fmt.Errorf("%w: requested tier differs from the server's account tier", errProtocol) }
	digest := sha256.Sum256([]byte(request.Prompt))
	digestText := fmt.Sprintf("%x", digest)
	var response *camoufoxnative.ProtectedResponse
	if _, textUser := camoufoxnative.GeneratePrompt(request.Body); textUser {
		response, err = entry.worker.Generate(ctx, camoufoxnative.GenerateTurn{Body: request.Body, ProofStart: start, ProofEnd: end, Digest: digestText})
	} else {
		proof, proofErr := entry.worker.Proof(ctx, digestText, request.Prompt)
		if proofErr != nil { return proofErr }
		encoded, err := json.Marshal(proof)
		if err != nil { return err }
		body := make([]byte, 0, len(request.Body)-(end-start)+len(encoded))
		body = append(body, request.Body[:start]...)
		body = append(body, encoded...)
		body = append(body, request.Body[end:]...)
		headers, err := entry.worker.ProtocolHeaders(ctx)
		if err != nil { return err }
		logging, err := catalogArray(entry.worker.PageCatalog().Logging)
		if err != nil { return err }
		binary, err := encodeJSPBFields(logging)
		if err != nil { return err }
		headers.Set("X-Goog-Ext-519733851-Bin", base64.StdEncoding.EncodeToString(binary))
		authorization, err := freshAuthorization(ctx, entry.worker)
		if err != nil { return err }
		headers.Set("Authorization", authorization)
		headers.Set("Content-Type", "application/json+protobuf")
		headers.Set("Priority", "u=0")
		switch tier {
		case 0:
		case 1: headers.Set("X-AIStudio-G1-Tier", "TIER1")
		case 2: headers.Set("X-AIStudio-G1-Tier", "TIER2")
		case 3: headers.Set("X-AIStudio-G1-Tier", "TIER0")
		}
		response, err = entry.worker.SendProtected(ctx, generateURL, headers, body)
		if err != nil { return err }
	}
	if err != nil { return err }
	defer func() { err = errors.Join(err, response.Body.Close()) }()
	headers := make(map[string]string, len(response.Header))
	for key, values := range response.Header { headers[key] = strings.Join(values, ", ") }
	if err := out.send(event{ID: request.ID, Event: "headers", Status: response.StatusCode, Headers: headers}); err != nil { return err }
	buffer := make([]byte, 64*1024)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			// Marshal []byte as base64 without decoding or trimming frame bytes.
			data, err := json.Marshal(buffer[:count])
			if err != nil { return err }
			if err := out.send(event{ID: request.ID, Event: "chunk", Data: data}); err != nil { return err }
		}
		if errors.Is(readErr, io.EOF) { return nil }
		if readErr != nil { return readErr }
	}
}

func (entry *account) benefitTier() (int, error) {
	raw, err := catalogArray(entry.worker.PageCatalog().Tier)
	if err != nil { return 0, err }
	var fields []json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil { return 0, err }
	tier := 0
	if len(fields) > 0 && string(fields[0]) != "null" {
		if err := json.Unmarshal(fields[0], &tier); err != nil { return 0, fmt.Errorf("server benefit tier: %w", err) }
	}
	if tier < 0 || tier > 3 { return 0, fmt.Errorf("unrecognized server benefit tier %d", tier) }
	return tier, nil
}

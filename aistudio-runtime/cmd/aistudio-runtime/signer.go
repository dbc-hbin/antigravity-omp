package main

// SAPISID signing and cookie selection are adapted from AIStudio2API
// internal/aistudio/{signer,auth}.go at bab7209eef0d5a8f9baed4652d7e4158a3adad7b
// (MIT; ../../LICENSE). Cookies are exported afresh from the live browser.
import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/omp/aistudio-runtime/internal/camoufoxnative"
)

const aiStudioOrigin = "https://aistudio.google.com"

type signingCookie struct {
	Name string `json:"name"`
	Value string `json:"value"`
	Domain string `json:"domain"`
	Path string `json:"path"`
	Expires float64 `json:"expires"`
}

func freshAuthorization(ctx context.Context, worker *camoufoxnative.Worker) (string, error) {
	encoded, err := worker.StorageCookies(ctx)
	if err != nil { return "", err }
	var cookies []signingCookie
	if err := json.Unmarshal(encoded, &cookies); err != nil { return "", err }
	now := time.Now().Unix()
	parts := make([]string, 0, 3)
	for _, item := range []struct{ label, name string }{
		{"SAPISIDHASH", "SAPISID"}, {"SAPISID1PHASH", "__Secure-1PAPISID"}, {"SAPISID3PHASH", "__Secure-3PAPISID"},
	} {
		value := ""
		for _, cookie := range cookies {
			if cookie.Name != item.name || cookie.Value == "" || cookie.Path != "/" || cookie.Expires >= 0 && cookie.Expires <= float64(now) { continue }
			domain := strings.TrimPrefix(cookie.Domain, ".")
			if domain != "aistudio.google.com" && !(strings.HasPrefix(cookie.Domain, ".") && strings.HasSuffix("aistudio.google.com", "."+domain)) { continue }
			value = cookie.Value
			break
		}
		if value == "" { return "", fmt.Errorf("%w: missing live signing cookie %s", camoufoxnative.ErrAuthenticationRequired, item.name) }
		digest := sha1.Sum([]byte(fmt.Sprintf("%d %s %s", now, value, aiStudioOrigin)))
		parts = append(parts, fmt.Sprintf("%s %d_%s", item.label, now, hex.EncodeToString(digest[:])))
	}
	return strings.Join(parts, " "), nil
}

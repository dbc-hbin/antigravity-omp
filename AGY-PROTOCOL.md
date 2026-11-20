# AGY protocol contract

## Scope

The package registers only the Antigravity extension (`index.ts`):

- `stream.ts` — the `antigravity-cli` request body: system prompt, contents, thinking config, tool declarations, tool-name and tool-argument conversion.
- `tool-contracts.ts` — bidirectional OMP ↔ AGY tool contracts for `read`, `grep`, `glob`, `write` (`read_file`, `grep_search`, `find_by_name`, `write_file`).
- `wire.ts` — native schema and protobuf enum encoding; `protocol.ts` — request/cascade labels; `transport.ts` — HTTP transport; `native-models.ts` — account roster; `oauth-engine.js` — OAuth adapter.

Verification uses loopback receivers and local fixtures only.

## Reference versions

The installed reference is agy 1.5.12 (`~/.local/bin/agy`, 226,575,952 bytes, SHA-256 `ef265356c3e5d3c6c241509cf71187bae086ac935ef5c5c037dadf62d5876835`, installed 2026-11-19 by the official updater), compared against the retained 1.5.9 binary.

The extension intentionally keeps the audited 1.5.9 identity (`index.ts`):

```http
User-Agent: antigravity/cli/1.5.9 (aidev_client; os_type=darwin; arrm64; cl=1021519450; auth_method=consumer)
```

### 1.5.9 → 1.5.12 differences

| Area | Result |
| --- | --- |
| Generation stream | No-data idle timeout 5 min → 10 min. |
| Retry | Server-requested retry-after allowance 30 s → 4 min; mid-stream failures are newly classified as retryable. |
| HTTP contract | Unchanged in the compared functions: `POST /v1internal:streamGenerateContent?alt=sse`, HTTP/1.1-only transport, header construction, chunked generation bodies. |
| Tool contract | `functionDeclarations`, `toolConfig` and tool call/result conversion unchanged across 54 built-in tool functions. Only tool *execution* policy changed (sandbox settings/credential file read restrictions, CRLF line-ending preservation on append). |

The shared stream API accepts per-call `streamIdleTimeoutMs` and `maxRetryDelayMs`; the recovery fixtures pin the 1.5.12 values (10 min, 4 min).

## HTTP transport

Observed `agy models` and generation requests target `https://daily-cloudcode-pa.googleapis.com`. The Cloud Code transport is **HTTP/1-only**: `newCloudCodeTransport` sets `Transport.Protocols` to HTTP/1, clears `TLSNextProto`, and removes `h2` from TLS ALPN. It reuses transports, raises `MaxIdleConnsPerHost` to 100, and leaves the response-header timeout at zero. Inherited defaults: 100 global idle connections, 90-second idle timeout, 30-second TCP dial timeout/keepalive interval, 10-second TLS handshake timeout. TLS config has no client session cache and no cipher/curve overrides.

```http
User-Agent: antigravity/cli/<version> (aidev_client; os_type=darwin; arrm64; cl=<client-cl>; auth_method=consumer)
Authorization: Bearer <access-token>
Content-Type: application/json
Accept-Encoding: gzip
```

The generation body is a `bytes.Reader` wrapped in `io.NopCloser`, which prevents the known-length/GetBody special case: native generation is chunked over HTTP/1, and nonempty generation bodies are not replayed on 307/308 redirects. Ordinary JSON control-plane and form OAuth requests have known byte lengths. `setHeaders` sets the User-Agent and JSON Content-Type for POST; OAuth supplies Authorization. Request context can additionally supply `X-Goog-Request-Reason` and a matching UA `purpose`; the CLI auth provider can supply `X-Goog-User-Project`. No explicit Accept, X-Goog-Api-Client, X-Client-Data, or hardware-fingerprint header was found in the analyzed consumer header-construction path.

Control-plane calls observed: `POST /v1internal:loadCodeAssist` with `{"metadata":{"ideType":"ANTIGRAVITY"}}`, and `fetchAvailableModels`, `fetchAdminControls`, `fetchUserInfo`, `retrieveUserQuotaSummary`, `listExperiments` with `{"project":"<discovered-project>"}`. Project IDs come from account discovery.

The extension's transport mirrors the native contract: proxy, CA, client-certificate and identity-callback isolation per connection pool; TLS session caching disabled; free sockets expire after 90 seconds, capped at 100 idle sockets per transport across its origins without limiting active streams. Direct connections use separate 30-second TCP and 10-second TLS-handshake deadlines; active SSE has no finite response deadline. **Proxy timing limit:** OMP's CONNECT helper exposes only a whole-tunnel promise/timeout, so native per-stage proxy connection deadlines are not reproduced. Cancellation and final extension shutdown abort pending tunnels and close pooled sockets.

**TLS fingerprint limit:** native AGY and the Bun implementation both advertise TLS 1.2/1.3 but differ in ClientHello cipher ordering, extension ordering, supported groups and signature algorithms (native: groups 4588/4587/4589/29/23/24/25, signature extensions 13 and 50; Bun: groups 4588/29/23/24, no extension 50). An HTTP version/header correction does not recreate Google's private Go/BoringCrypto build. Certificate checks remain enabled; no guessed fingerprint, fabricated hardware ID, or weaker TLS policy is added to conceal this difference.

## OAuth

The consumer client ID and embedded client secret match OMP's existing `google-antigravity` auth policy. The secret is not reproduced here. The authorization-code flow uses:

- Authorization endpoint: `https://accounts.google.com/o/oauth2/auth`.
- Redirect: `http://localhost:<ephemeral-port>/auth/callback`.
- `response_type=code`, `access_type=offline`, `prompt=consent`, random state, and PKCE S256. The token exchange includes `code_verifier`.
- Scopes, in order: `https://www.googleapis.com/auth/cloud-platform`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/cclog`, `https://www.googleapis.com/auth/experimentsandconfigs`, `https://www.googleapis.com/auth/aicode`.
- Token endpoint: `https://oauth2.googleapis.com/token`. The recovered OAuth endpoint has `AuthStyle=1` (credentials in the form body).
- User identity: `GET https://www.googleapis.com/oauth2/v2/userinfo`, bearer authorization, `User-Agent: Go-http-client/2.0`, `Accept-Encoding: gzip`.

The extension reuses OMP's authorization-code engine and callback server, including state validation, PKCE, cancellation, credential projection and the project hook. Only the audited URL/callback configuration changes.

Run `bun install --frozen-lockfile` in the extension checkout before loading it, including when linked from `~/.omp/agent/extensions`. Keep its local `node_modules`: the OAuth engine adapter imports dependency source files from that directory, so OMP's bundled packages alone are insufficient. After restoring dependencies, verify loading with `omp models google-antigravity --no-extensions -e ./index.ts --json`; this lists models without sending a generation request.

OMP's compiled extension loader supplies bundled aliases for explicit Pi package exports, but not the `registry/engine/*` wildcard exports. `oauth-engine.js` re-exports the two engine helpers through relative dependency source paths so the loader traverses and rewrites their dependencies; its matching `.d.ts` re-exports the dependency's published declarations. This follows the [18.19.0 loader's module collection contract](https://github.com/can1357/oh-my-pi/blob/v18.19.0/packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts).

The CLI also contains enterprise/WIF, ADC, remote authentication and API-key paths. This change aligns the existing consumer OAuth provider; those separate authentication products were not implemented or exercised.

## Generation JSON

`POST /v1internal:streamGenerateContent?alt=sse` has these top-level fields:

```json
{
  "project": "<discovered-project>",
  "model": "<serving-model-id>",
  "userAgent": "antigravity",
  "requestType": "agent",
  "requestId": "agent/<cascade-id>/<timestamp>/<trajectory-id>/<step>",
  "request": {
    "sessionId": "-3750763034362895579",
    "labels": {
      "cascade_id": "<cascade-id>",
      "root_cascade_id": "<cascade-id>",
      "trajectory_id": "<trajectory-id>",
      "request_id": "<trajectory-id>-<request-index>",
      "last_step_index": "<step-minus-one>",
      "model_enum": "<roster-model-enum>",
      "used_claude": "false",
      "used_claude_conservative": "false",
      "used_non_gemini_model": "false"
    },
    "contents": [{ "role": "user", "parts": [{ "text": "<prompt>" }] }],
    "systemInstruction": { "role": "user", "parts": [{ "text": "<system>" }] },
    "generationConfig": { "thinkingConfig": {} }
  }
}
```

This illustrates the envelope, not a runnable prompt. Session ID is the signed decimal FNV-1a offset basis from an empty session-source slot. A primary conversation repeats its cascade as root; an explicit parent root is preserved for child conversations. Trajectory IDs, step counters and labels come from OMP's request builder and session context.

`toolConfig` is omitted when no explicit choice was supplied. Static `buildToolConfig` distinguishes that from explicit `auto`, which sends `VALIDATED`. Explicit `required` sends `ANY`, `none` sends `NONE`, and a named function sends `ANY` with `allowedFunctionNames`. These explicit settings remain present even without tool declarations. Sampling parameters, `userPromptId` and opt-in `enabledCreditTypes` are absent.

The captured Gemini 3.8 Flash Low request has `maxOutputTokens: 65536` and `thinkingConfig: {"includeThoughts":true,"thinkingLevel":"LOW"}`; the model 4.6 has `maxOutputTokens: 64000` and `thinkingConfig: {"includeThoughts":true,"thinkingBudget":1024}`. These values belong to roster/model selection rather than global constants.

### Request derivation in the extension

`stream.ts` registers a distinct `antigravity-cli` API so it can retain the original options, messages and tool schemas before the inherited CCA builder rewrites them. It delegates streaming/response handling to OMP's Gemini API and replaces the outgoing request body. The Gemini model is rebuilt from its spec when delegating, because custom API models do not have Gemini's resolved compatibility fields.

`native-models.ts` retains the successful `fetchAvailableModels` response by its authorization header. The startup refresh uses `online` mode: the normalized disk cache lacks the raw native fields (`ApiProvider`, `MinThinkingBudget`, `SupportsThoughtCirculation`) even when its TTL is valid. A missing row stops generation instead of guessing an opaque model enum or using another account's metadata.

`nativeWireRequest` converts tool schemas to native Schema: type, description, properties, items, valid required names, string enum positions, default, format, pattern and supported numeric bounds survive; combiners, nullable, title and other unassigned fields are dropped. Length/item bounds truncate to int64 and serialize as decimal strings. For thinking levels `EXTRA_HIGH=5` and `MAX=6`, all populated protobuf enums use numbers; `XHIGH=7` retains names. Arbitrary JSON function arguments, responses and defaults are not enum-rewritten.

## Tool names and contracts

Server-visible tool names are adapted: `read` → `read_file`, `bash` → `run_command`, `write` → `write_file`, `edit` → `edit_file`, `task` → `invoke_subagent`, `web_search` → `search_web`, `ask` → `ask_question`. `apply_patch` → `edit_file` applies only when `edit` is absent. Each request derives a reversible map from declarations, historical assistant calls and any named choice; original names reserve their identity, so an occupied alias conservatively leaves the OMP name unchanged rather than merging tools. Unknown/custom/MCP names stay unchanged. Declarations, historical calls, ID-paired responses and explicit allowed names use this map; all streamed partials, completed calls and final/error messages restore OMP names.

Contracted tools (`read`, `grep`, `glob`, `write`) keep their OMP declarations for host features such as `xd://` and regex searches. They additionally declare `read_file`, `grep_search`, `find_by_name`, or `write_file` when the native name is unoccupied and the route can supply the host's required arguments. Device-only or description-pruned `write` stays on the OMP route. Native declarations preserve the host's `i` field when present. Calls that fail native validation become OMP argument errors without reaching execution; local native searches use a checked canonical target. Replay uses the native name only when its arguments still meet the native contract, and only known native reads are re-encoded as `read_file`. Otherwise the OMP name and arguments remain paired with the response. All other tools keep names-only compatibility.

## System prompt and tool inventory

For all `google-antigravity` models using the agent stream, the default OMP role uses the AGY preset vendored in [`prompts/agy.ts`](prompts/agy.ts) from [OMP Superkit `2795c12`](https://github.com/dbc-hbin/omp-superkit/blob/2795c128f238cb222b49079193664f5756ba2f37/prompts/agy.ts). Superkit is not a runtime dependency. An already-rendered AGY preset is kept; another marked Superkit profile is replaced without losing its delegated execution rules. An explicit custom system prompt does not receive the default preset.

The host's compact or inline tool inventory is built from the final `request.tools[].functionDeclarations` after the awaited payload hook. Names and descriptions therefore match the translated tools on the wire, including both routes for contracted tools where available. Host policy, skills, project context and specialist assignments are not rewritten by this projection.

System-prompt branding is applied only after the caller's awaited `onPayload` hook has finished. The host's `⁂ Role` introduction changes from `You are omp's trusted coding assistant.` to `You are Antigravity's trusted coding assistant.` in the outgoing `request.systemInstruction` only. Known ULW preset introductions beginning `You are omp, a coding agent` and the `OMP todo updates` / `OMP shell execution` headings receive the same branding; model names, specialist roles and all following instructions stay intact. The original context and hook-owned objects are not mutated. Commands, paths, package names, workflow and safety instructions, user messages and tool descriptions are not globally searched or rewritten.

## Device identifiers

The recovered CCPA outer/nested request types and analyzed builder/header paths do not attach hardware or installation metadata. The session helper hashes an input string with FNV-1a64; it does not query hardware. CLI `setUpInstallationID` reads or creates a random UUIDv4 in `~/.gemini/antigravity-cli/installation_id` (under configurable app-data roots), and error diagnostics serialize that UUID as `AntigravityExtension.installation_id` field 5 to the separate CEL/Clearcut path targeting `https://play.googleapis.com/log`.

Analytics additionally copy `Metadata.DeviceFingerprint` into `extras["machineId"]`; this is a different field from the installation UUID. A linked OTel Darwin collector can query `IOPlatformUUID`; its execution/transmission in the CLI was not established, and the recovered default detector list does not include host-ID collection. A generation prompt section can conditionally include the OS hostname, while remote control has its own hostname-derived instance name. Neither flag activation nor universal identifier absence is claimed.

No installation UUID, hardware UUID, hostname, or credential value was queried or copied into the extension. The extension retains its actual OS/architecture and established session contract; it does not manufacture analytics or remote-control requests.

## Verification

`bun test`: 99 passed, 0 failed (2026-11-20). Coverage includes OAuth authorization URL/callback/PKCE contract, native HTTP/1.1 framing, gzip, cancellation, proxy/TLS handling, original-schema conversion without CCA combiner/nullable rewriting, explicit tool modes without tools, account isolation, roster thinking defaults, IDs, signatures, circulation and inline images, tool-name aliasing in both directions, and AGY tool-contract conversion (native declarations, inbound argument decode, history replay encode). `bunx tsc --noEmit` passes.

The 1.5.12 stream behavior is pinned in `stream-recovery.test.ts` against loopback receivers with external sends blocked: SSE idle timeout at the 10-minute boundary, 429 recovery when the server requests an immediate retry, no replay when `retry-after` exceeds the 4-minute cap, and EOF without a final SSE event reported as an error after delivering partial text.

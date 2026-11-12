# agy 1.5.6 protocol audit

Official installer: <https://antigravity.google/cli/install.sh>. Authentication documentation: <https://antigravity.google/docs/install?tab=cli>.

Audited on 2026-11-12. Installed executable: `~/.local/bin/agy`, Darwin arm64, 233,521,200 bytes, SHA-256 `c55b821d5efcfd7ca7fdadbc870d1247cc0ccd31137291fee83fb0e342dc753a`. The installer verified the release manifest's SHA-512 before installation. `agy --version` returned `1.5.6`; `agy models` successfully returned the serving account's model list.

## OAuth

The consumer client ID and embedded client secret match OMP's existing `google-antigravity` auth policy. The secret is not reproduced here. The authorization-code flow uses:

- Authorization endpoint: `https://accounts.google.com/o/oauth2/auth`.
- Redirect: `http://localhost:<ephemeral-port>/auth/callback`.
- `response_type=code`, `access_type=offline`, `prompt=consent`, random state, and PKCE S256. The token exchange includes `code_verifier`.
- Scopes, in order: `https://www.googleapis.com/auth/cloud-platform`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/cclog`, `https://www.googleapis.com/auth/experimentsandconfigs`, `https://www.googleapis.com/auth/aicode`.
- Token endpoint: `https://oauth2.googleapis.com/token`. The recovered OAuth endpoint has `AuthStyle=1` (credentials in the form body). Authorization-code and refresh grants retain OMP's existing form encoder and credential handling.
- User identity: `GET https://www.googleapis.com/oauth2/v2/userinfo`, bearer authorization, `User-Agent: Go-http-client/2.0`, `Accept-Encoding: gzip`.

The extension reuses OMP's authorization-code engine and callback server, including state validation, PKCE, cancellation, credential projection and the project hook. Only the audited URL/callback configuration changes. Existing refresh grants remain associated with the same OAuth client.

OMP's compiled extension loader supplies bundled aliases for explicit Pi package exports, but not the `registry/engine/*` wildcard exports. `oauth-engine.js` re-exports the two engine helpers through relative dependency source paths so the loader traverses and rewrites their dependencies; its matching `.d.ts` re-exports the dependency's published declarations. The registry import remains on the host's explicit bundled alias. This follows the [18.19.0 loader's module collection contract](https://github.com/can1357/oh-my-pi/blob/v18.19.0/packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts). A bare deep import failed in the installed CLI, while a direct TypeScript source import pulled the dependency's implementation into the consumer's stricter typecheck. The JS/declaration pairing retains the library's existing runtime/type boundary without changing compiler checks or dependencies.

The CLI also contains enterprise/WIF, ADC, remote authentication and API-key paths. This change aligns the existing consumer OAuth provider; those separate authentication products were not implemented or exercised.

## HTTP

Observed `agy models` and generation requests use HTTP/2 against `https://daily-cloudcode-pa.googleapis.com`.

```http
User-Agent: antigravity/cli/1.5.6 (aidev_client; os_type=darwin; arch=arm64; cl=1018951551; auth_method=consumer)
Authorization: Bearer <access-token>
Content-Type: application/json
Accept-Encoding: gzip
```

Neither `Accept`, `Client-Metadata`, `x-goog-api-client` nor `anthropic-beta` was present in the captured CCPA calls. Ordinary control-plane POSTs have Content-Length. The native generation stream omits Content-Length. The extension applies the native transport to CCPA discovery/account requests as well as generation and its own OAuth refresh requests. Other providers' Google OAuth client IDs retain their existing fetch path.

Observed control-plane calls include `POST /v1internal:loadCodeAssist` with `{"metadata":{"ideType":"ANTIGRAVITY"}}`, and `fetchAvailableModels`, `fetchAdminControls`, `fetchUserInfo`, `retrieveUserQuotaSummary`, and `listExperiments` with `{"project":"<discovered-project>"}`. Project IDs come from account discovery; the captured account's value is not made a new default.

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

This illustrates the envelope, not a runnable prompt. Session ID is the signed decimal FNV-1a offset basis from an empty session-source slot; both native captures agree. A primary conversation repeats its cascade as root; an explicit parent root is preserved for child conversations. Trajectory IDs, step counters and labels continue to come from OMP's request builder and session context.

The native captures omit `toolConfig` because no explicit choice was supplied. Static `buildToolConfig` distinguishes that from explicit `auto`, which sends `VALIDATED`. Explicit `required` sends `ANY`, `none` sends `NONE`, and a named function sends `ANY` with `allowedFunctionNames`. These explicit settings remain present even without tool declarations. Sampling parameters, `userPromptId` and opt-in `enabledCreditTypes` are absent.

The captured Gemini 3.8 Flash Low request has `maxOutputTokens: 65536` and `thinkingConfig: {"includeThoughts":true,"thinkingLevel":"LOW"}`. Claude Sonnet 4.6 has `maxOutputTokens: 64000` and `thinkingConfig: {"includeThoughts":true,"thinkingBudget":1024}`. These values belong to roster/model selection rather than global constants. The captured current-model and conversation-history labels are retained.

## Static follow-up, without OAuth

This follow-up used REA function slices, original-file data and static LLDB disassembly. It did not execute agy, start OAuth or refresh real credentials. Existing OAuth implementation and endpoint settings were left unchanged. The first local OMP smoke fixture failed to load its extension and fell through to the default endpoint: a fake-token request was rejected with HTTP 401. Subsequent CLI verification was placed behind an OS network policy permitting only loopback connections.

`stream.ts` registers a distinct `antigravity-cli` API so it can retain the original options, messages and tool schemas before the inherited CCA builder rewrites them. It delegates streaming/response handling to OMP's Gemini API and replaces the outgoing request body. The Gemini model is rebuilt from its spec when delegating, because custom API models do not have Gemini's resolved compatibility fields.

`native-models.ts` retains the successful `fetchAvailableModels` response by its authorization header. The existing startup refresh uses `online` mode: the normalized disk cache lacks the raw native fields even when its TTL is valid. The host's normalized catalog discards `ApiProvider`, `MinThinkingBudget` and `SupportsThoughtCirculation`; the request builder therefore reads the original serving account's roster. A missing row stops generation instead of guessing an opaque model enum or using another account's metadata. Actual generation consequently requires that account's model roster to have been loaded; this follow-up uses local fixture rosters only.

The request uses the routed model ID and its roster `model` as `labels.model_enum`. A supplied Google thinking level wins over the roster level; a nonzero level excludes `thinkingBudget`. Otherwise the roster's normal or minimum budget is emitted, including explicit zero. `includeThoughts` follows thinking support/suppression. The maximum comes from an explicit total-output option, otherwise the roster cap.

Tool declarations use one entry per function. Native Schema conversion keeps only type, description, properties, items, valid required names, string enum positions, default, format, pattern and the supported numeric bounds. It drops combiners, nullable, title and other unassigned fields. Length/item bounds truncate to int64 and serialize as decimal strings. Empty ordinary fields omit; explicit defaults and allocated empty child schemas survive. For thinking levels `EXTRA_HIGH=5` and `MAX=6`, all populated protobuf enums use numbers; `XHIGH=7` retains names. Arbitrary JSON function arguments, responses and defaults are not enum-rewritten.

Calls/results preserve their original IDs. Consecutive results form one turn, using role `user` for `API_PROVIDER_ANTHROPIC_VERTEX=26`, otherwise `model`. Result names come from preceding calls. Images use inline MIME/data, including images nested inside function responses; image-only results retain an empty output string. No forced-tool instruction, remote image reference or bypass thought signature is invented. User whitespace survives. System instructions always have role `user` and one text part, including empty text.

Assistant thoughts require nonblank text and either a signature or roster thought-circulation support. Signatures are validated as base64. A message signature is placed on the first non-thought part, or the first part if all are thoughts; it can overwrite that part's per-call signature. Empty signed thoughts do not manufacture signature-only parts.

## Evidence and limits

Private raw evidence and redacted request captures are in `/tmp/agy-rea.6UdP4n`. Credentials were removed from captured authorization headers and OAuth body fields. The directory also contains binary metadata, assembly, selected native function slices and REA JSON. It contains private CLI prompt/telemetry context and should not be published wholesale.

REA 6.8.0 with Ghidra 12.1.4 could not complete whole-binary auto-analysis: the build uses Go 1.28, whose RTTI is unsupported by that Ghidra version, and analysis hit the 330-second deadline. Function names and source byte ranges were recovered separately from the Go pclntab. Exact function slices were then decompiled with REA as raw little-endian ARM64 at their original virtual addresses. Calls/data outside each slice remain unresolved in that decompilation; corresponding original-file data and call targets were inspected separately.

| Evidence | Native location / source range | REA evidence ID |
| --- | --- | --- |
| Go build metadata | Whole executable | `ev_c4c61ef76e1db7a3ef551c4e06a6d1c884ff6d4a29bdb1de22911502c4c661b3` |
| `authclient.getOAuthConfig` | VA `0x10222d690`, offset `35837584`, 1280 bytes | `ev_246394730ff062fda8000a9ec8450dac01ea9c0735aceefb641aef5085e4d992` |
| `authclient.buildAuthCodeURL` | VA `0x102224da0`, offset `35802528`, 528 bytes | `ev_89b6506ad568ee58fda847f61409027e299fb3b0ab0627f4c93299a611c66400` |
| `codeassistclient.setHeaders` | VA `0x1020b6410`, offset `34300944`, 848 bytes | `ev_ee09b56fae08420e667bb43138d225b52d1b0c190d96f11ab77cc94f24c28987` |
| `codeassistclient.BuildGenerateContentRequest` | VA `0x1020ad5b0`, offset `34264496`, 4128 bytes | `ev_ee331cedd3a34704f715931adb12569f5495437897fe8a994d878b0213e4731e` |
| `model_config.ModelDetailsToModelInfo` | VA `0x100b1afa0`, offset `11644832`, 1136 bytes | `ev_7748be0f889b079fbac212a85d7bf3bc1cacf701813bc3ea091bd02f564de88c` |
| `backend.ResolveEffort` | VA `0x102aba980`, offset `44804480`, 2720 bytes | `ev_3c27ce92226be282adcbc443f9a84457f66470bfb7b9605ea9d853f833f6ae2c` |
| `codeassistclient.marshalCCPARequest` | VA `0x1020aeee0`, offset `34270944`, 240 bytes | `ev_9e7aee27a3ee87423235f401ae2111231879a2ba80920aae854da63dcb847684` |
| `codeassistclient.buildToolConfig` | VA `0x1020ad290`, offset `34263696`, 800 bytes | `ev_64932c7bf311f6b156078f6b5a0273c5b4bd76f2c33fbb7aec027123ea5ac194` |
| `codeassistclient.convertMapToSchema` | VA `0x1020a4620`, offset `34227744`, 2080 bytes | `ev_55f78d10f74a2564d23a9e30ff5fb1dfa6ccd0c7399faeba7dddfa63d2e86d5f` |

`BrowserTokenAcquirer.AcquireToken` at `0x102222cf0` calls PKCE `GenerateVerifier`, state generation, the authorization URL builder and `Config.Exchange`. Its assembly supplies the localhost redirect format and `code_verifier`. Scope arrays and endpoint strings were resolved from the original binary's referenced Go string/slice data, not inferred from unrelated strings.

Generation captures were stopped at the local proxy with HTTP 418 before upstream dispatch. Native CLI output reported zero input/output/thinking tokens. No paid inference was performed. Actual generated responses, native SSE payloads, TLS ClientHello/HTTP2 SETTINGS fingerprint equivalence, and enterprise/remote authentication are not established by these captures. Local receiver tests exercise the extension's SSE decoding, gzip, cancellation and TLS/proxy handling separately.

## Earlier verification

- `bun test`: 54 passed, 0 failed, including the OAuth authorization URL/callback/PKCE contract, explicit tool choices, native HTTP/2 headers, gzip, cancellation and proxy/TLS handling.
- `bun run check`: passed. Scoped `oxlint --type-aware --deny-warnings` passed for all 10 changed source/test/declaration files. Source and test audits passed. The unscoped `bun run lint` command also scans `node_modules` and fails on existing dependency warnings; those files were not changed.
- The OAuth regression was checked by temporarily restoring the old authorization URL; it failed on that exact mismatch before the native URL was restored.
- The installed OMP CLI loaded the final extension with its JS/declaration binding, sent a request to a temporary loopback receiver and printed `OK` with exit code 0. The received CLI User-Agent, agent envelope, signed session ID and primary root/cascade labels matched the audited contract. This receiver used HTTP/1; native HTTPS/HTTP2 framing is covered separately by transport receiver tests.
- A separate HTTP/2 userinfo GET probe received status 200 and observed the Go User-Agent, gzip, no Accept and no Content-Length.
- Independent read-only code review reported no findings. The OAuth exchange, live inference and binary-analysis coverage limits above remain.

Final check transcripts, the OMP receiver readback and source SHA-256 list are retained in `/tmp/agy-rea.6UdP4n` (`*-complete.txt`, `omp-request-final.json`, `verified-sha256.txt`). The temporary proxy was stopped and verification scripts were removed. New browser consent and a live upstream inference response were not exercised.

## Static follow-up verification

- The full suite passed: 66 tests, 0 failures, 234 expectations. After the final startup refresh change, its affected suite passed again: 46 tests, 179 expectations. This includes actual local HTTP receivers, original-schema conversion, explicit tool modes without tools, account isolation, roster thinking defaults, IDs, signatures, circulation and inline images.
- `bun run check` passed. Scoped `oxlint --type-aware --deny-warnings` passed for the nine changed TypeScript source/test files, with the subsequent changes to `index.ts` and `stream.test.ts` checked separately. The earlier dependency-only failure of unscoped lint was not rerun.
- Installed OMP 18.19.0 loaded the extension, registered `antigravity-cli`, and completed a local request with a fake token. A temporary CLI command exercised the registered API and production session-label hook. It printed `AGY_STATIC_OK` and exited 0. macOS sandbox policy denied non-loopback networking; numeric loopback avoided DNS inside that policy.
- The received request used `gemini-3.8-flash-high`, `MODEL_PLACEHOLDER_M318`, `thinkingLevel: HIGH`, `includeThoughts: true`, `maxOutputTokens: 65536`, explicit `NONE` without tools, the signed session ID, primary root/cascade labels and the audited CLI User-Agent. The loopback receiver uses HTTP/1; native HTTPS/HTTP2 framing is covered by the existing transport tests.
- The first smoke fixture incorrectly used absolute imports, which OMP's dependency collector does not traverse. Its fallback request with a fake token received 401. The corrected fixture used relative imports and process-level networking restrictions. It did not use or store real OAuth credentials.

Current evidence and check transcripts are in `/tmp/agy-static.wVrtVc`, including `wire/field-layouts.json`, `tests-corrected.txt`, `startup-tests.txt`, `startup-types.txt`, `cli-smoke-numeric-loopback.txt` and `cli-request.json`. Temporary CLI state and smoke scripts were removed. Successful upstream inference, OAuth exchange and full TLS/HTTP2 fingerprint equivalence remain unverified; OAuth was deferred as requested.

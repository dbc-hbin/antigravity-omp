# AGY protocol audits

## Extension scope

The package registers only the Antigravity extension (`index.ts`). The experimental AI Studio provider, its tests, and its bundled Go/Camoufox runtime were removed. Shared dependencies and external account/session data are unchanged.

## Current reference: agy 1.5.9

Updated on 2026-11-14 from the [official macOS ARM64 release manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json), which advertised 1.5.9. The release archive SHA-512 matched `690cd6a5a5fdb23564fb1b14f7f6ae368fa3636b7630f56c574a6dfc0e2791a0e5b93d6515be1650c8a268cfb28440e1b9cbaa1c5b85aa762ab25b51c1fccda5` before installation. Installed `agy --version` reports 1.5.9; its SHA-256 matches the extracted official binary: `fad3628ad91fe8613a72f074a1c5fde7cd816517788a5b9be96703f7d256741a`. The old binary is retained at `/tmp/agy-159.eqzYFI/agy-1.5.8` for comparison.

The extension now emits:

```http
User-Agent: antigravity/cli/1.5.9 (aidev_client; os_type=darwin; arch=arm64; cl=1021519450; auth_method=consumer)
```

Fresh REA analysis covered 18 selected HTTP/header/transport/OAuth/body-construction functions. Address-normalized pseudocode and ordered referenced literals match 1.5.8; original transport/TLS/client field tables and selected defaults corroborate the comparison. This is bounded contract evidence, not a proof of whole-program equivalence. Recovered changes are the default version and client CL; the compiler build is unchanged. HTTP/1-only selection, connection defaults, conditional header/UA fields, chunked generation and non-replayable generation 307/308 behavior remain as documented below.

New evidence:

- `/tmp/agy-159.eqzYFI/go-metadata.json`: `ev_71c409fb339b816d9ab7b82e8198940b227603d75f9a4d9fc667c4a262452c70`.
- `/tmp/agy-159.eqzYFI/http/http-contract-comparison.json` and `http/findings.json`.
- `setHeaders`, VA `0x102145da0`: `ev_9dc7a5fa7bb63cc0c9648905c7c0560d2fd581a652f2f88d2027762ecd42653e`.
- `userAgent`, VA `0x1021454d0`: `ev_c91542b185e2a8e811e04e3f3a5ce3e002db3a965b2e902b01150b9c278f757f`.
- `newCloudCodeTransport`, VA `0x102144230`: `ev_8df058b4d3e061c0ef489f91335e90d94fd036b4cfdd2f68bb9fe65f56be96fc`.
- CCPA streaming body, VA `0x10213e6a0`: `ev_f374e9dc5762cb13ed5b56eff383b9be09f37fa9ff0dd586317a5da6e8fd8a89`.

Fresh native capture `/tmp/agy-159.eqzYFI/native-wire.json` again stopped the required OAuth refresh locally with 418. Its parsed ClientHello fields, HTTP/1.1 negotiation and OAuth header names/order/values match the earlier native observation. No native CCPA request or successful token refresh was obtained. Extension capture `extension-wire.json` verifies four HTTPS request types using the registered 1.5.9/CL identity, ordinary Content-Length, chunked generation, no GET framing and no automatic Connection header. The remaining TLS-stack and proxy timing differences below are unchanged. Relevant extension/protocol/transport tests passed: 59 tests, 0 failures; TypeScript checking passed.

The targeted device comparison covered 44 functions (9,880 ARM64 instructions), nine relevant type contracts, and 14 fresh REA slices. Address relocations and five verified `Server` field-offset changes account for the observed instruction differences; direct-call identities and the inspected identity field/string contracts remain unchanged. `Server` gained workspace-trust/memory-monitor fields, shifting the existing trajectory-store and session-hostname slots rather than introducing a new identifier source. Generation still has no dedicated hardware/installation field in the examined schemas/builders; random installation UUID, inherited analytics `machineId`, CEL installation logging and conditional hostname paths retain the prior split. Hostname-flag activation and arbitrary inherited fingerprint provenance remain unresolved. Evidence: `/tmp/agy-159.eqzYFI/device/device-identity-comparison.json`; installation `ev_047e7bd07f71bacc2021252133524cd1a252f1d47221bbd632f14e967fe888d5`; analytics `ev_fdf410ce112d203e9fa2da0d31b976afa14ca39d6523396a5b6bf9e206078f36`; generation builder `ev_cb56c73cc624fac352b722457322f18e7741d8879bfc47c818d55e94372c049f`.

## Previous reference: agy 1.5.8

Audited on 2026-11-14: Darwin arm64 `~/.local/bin/agy`, 235,205,648 bytes, SHA-256 `b127126993e1c5b7e0b1ef80fa9bbe6955ddb85a5d76a3310b6096acc7eb000a`. REA Go metadata identifies Google's `go1.28-20261102-RC00 cl/1012564305 +298f53e483 X:fieldtrack,boringcrypto,simd,nogolistexportnewformat`. That compiler CL is not the client CL.

The current Cloud Code transport is **HTTP/1-only**, superseding the earlier 1.5.6 HTTP/2 observation below. `newCloudCodeTransport` explicitly sets `Transport.Protocols` to HTTP/1, clears `TLSNextProto`, and removes `h2` from TLS ALPN. It reuses transports, raises `MaxIdleConnsPerHost` to 100, and leaves the response-header timeout at zero. Inherited defaults include 100 global idle connections, a 90-second idle timeout, a 30-second TCP dial timeout/keepalive interval, and a 10-second TLS handshake timeout. A new ordinary TLS config has no client session cache or explicit cipher/curve overrides.

The default consumer CLI identity recovered from `main.initMetadata` and `CodeAssistClient.userAgent` is:

```http
User-Agent: antigravity/cli/1.5.8 (aidev_client; os_type=darwin; arch=arm64; cl=1020628950; auth_method=consumer)
```

The generation body is a `bytes.Reader` wrapped in `io.NopCloser` before Go's `NewRequestWithContext` sees it. That wrapper prevents the known-length/GetBody special case: native generation is chunked over HTTP/1, and nonempty generation bodies are not replayed on 307/308 redirects. Ordinary JSON control-plane and form OAuth requests have known byte lengths.

`setHeaders` sets the User-Agent and JSON Content-Type for POST; OAuth supplies Authorization. Request context can additionally supply `X-Goog-Request-Reason` and a matching UA `purpose`, and the CLI auth provider can supply `X-Goog-User-Project`. The native UA has conditional privacy/host/proxy fields; their defaults were not established, so the extension does not invent them. No explicit Accept, X-Goog-Api-Client, X-Client-Data, or hardware-fingerprint header was found in this analyzed consumer header-construction path.

Runtime evidence is deliberately separate from static evidence. A loopback-only receiver and OS network restriction captured native `agy models`; the installed account required refresh, so the receiver stopped its OAuth `/token` request with HTTP 418 rather than forwarding it or returning a token. Observed ALPN was `http/1.1`, with `Go-http-client/1.1`, form Content-Type, Content-Length and gzip. No live CCPA generation or successful OAuth refresh was performed. Separate telemetry connections offered `h2,http/1.1`; their transport must not be confused with the Cloud Code transport. The capture used `GODEBUG=netdns=go` only to resolve localhost under the network restriction.

**TLS fingerprint limit:** the original Bun implementation and AGY advertise TLS 1.2/1.3, but their ClientHello cipher ordering, extension ordering, supported groups and signature algorithms differ. Native AGY advertises groups 4588/4587/4589/29/23/24/25 and signature extensions 13 and 50; the captured Bun stack advertises 4588/29/23/24 and no extension 50. An HTTP version/header correction does not recreate Google's private Go/BoringCrypto build. Certificate checks remain enabled; no guessed fingerprint, fabricated hardware ID, or weaker TLS policy is added to conceal this difference.

The updated extension's local HTTPS capture negotiated `http/1.1` for control, generation, userinfo and OAuth-token requests. It emitted the current CLI UA, UTF-8 Content-Length for control/token bodies, chunked generation, and no GET body framing. Public request options suppress Node's automatic Connection header without disabling reuse; the final capture's OAuth header names/order and noncredential values match the native observation, apart from the fixture's body length. Capture: `/tmp/agy-extension-after-transport.json`; all tokens/bodies were local fixtures and the receiver returned 418 without upstream dispatch. Current CCPA header construction is supported by static REA evidence plus extension readback, not a successful native CCPA capture.

Connection pools preserve proxy, CA, client-certificate and identity-callback isolation, disable TLS session caching, expire free sockets after 90 seconds, and cap idle sockets at 100 per transport across its origins without limiting active streams. Direct connections use separate 30-second TCP and 10-second TLS-handshake deadlines; active SSE has no finite response deadline. **Proxy timing limit:** OMP's CONNECT helper exposes only a whole-tunnel promise/timeout, so native per-stage proxy connection deadlines are not reproduced. Cancellation and final extension shutdown abort pending tunnels and close pooled sockets.

Verification: the initial transport/extension/protocol run passed 56 tests. After lifetime/header refinements, all 42 transport tests passed, including framing, reuse, idle limits, direct deadlines, TLS/client-certificate isolation, proxy cancellation and generation redirect non-replay. Type checking passed after correcting timer-test overload annotations; the two affected deadline tests passed again. Final HTTPS wire capture covered four local request types. Throwaway capture scripts were removed.

### Device identifiers are not interchangeable

The recovered CCPA outer/nested request types and analyzed builder/header paths do not attach hardware or installation metadata. The session helper hashes an input string with FNV-1a64; it does not query hardware. Separately, CLI `setUpInstallationID` reads or creates a random UUIDv4 in `~/.gemini/antigravity-cli/installation_id` (under configurable app-data roots). Error diagnostics serialize that UUID as `AntigravityExtension.installation_id` field 5 to the separate CEL/Clearcut path targeting `https://play.googleapis.com/log`.

Analytics additionally copy `Metadata.DeviceFingerprint` into `extras["machineId"]`; this is a different field from the installation UUID. Ordinary CLI metadata initialization sets IDE name/version/product, not a hardware fingerprint, but metadata can be inherited from a Protobuf stdin input. A linked OTel Darwin collector can query `IOPlatformUUID`; its execution/transmission in the CLI was not established, and the recovered default detector list does not include host-ID collection. A generation prompt section can conditionally include the OS hostname, while remote control has its own hostname-derived instance name. Neither flag activation nor universal identifier absence is claimed.

No installation UUID, hardware UUID, hostname, or credential value was queried or copied into the extension for this analysis. The extension retains its actual OS/architecture and established session contract; it does not manufacture analytics or remote-control requests. Device evidence: `/tmp/agy-device-158.EJebv3/device-identity-manifest.json`; installation `ev_46ce8d3fd662ca53f74a64864669c0911aaf92fa989e1611514d773751a6b980`; analytics `ev_d875afa6928708ec05cf4a399d27fcaf8554ee8b3e8bff154aa72532cfc84316`; CEL transmission `ev_fdabb3cdcbb83d6521f1d634a94006dd700f00e32748b3fe28a8aa5ddd657b89`.

REA evidence: `/tmp/agy-http-158.WuX4W1/http-contract-evidence.json`; native runtime capture (credential values omitted): `/tmp/agy-native-158-transport.json`; pre-change extension capture: `/tmp/agy-extension-before-transport.json`.

| Native function | Address | REA evidence |
| --- | --- | --- |
| `newCloudCodeTransport` | `0x10210eb40` | `ev_73bb10941250f785bb37629a0fee1ff70980089ea0944a07711e855610137ec3` |
| `CodeAssistClient.setHeaders` | `0x1021106b0` | `ev_6d7fa945f5dac311018dab519ad5ee88c7ee8a83dd91a5a8e0300b587e919e0a` |
| `codeassistclient.userAgent` | `0x10210fde0` | `ev_24fd790086177c3db804f0417888f59e7c0f8028ff8f56e011adbdf0f3fa87d1` |

## Historical reference: agy 1.5.6

The remaining native-capture sections describe the 2026-11-12/13 evidence. The 1.5.8 section above supersedes their version, client CL and HTTP/2 transport claims; the older captures are not rewritten as if they came from the current binary.

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

Server-visible tool names are adapted: `read` → `read_file`, `bash` → `run_command`, `write` → `write_file`, `edit` → `edit_file`, `task` → `invoke_subagent`, `web_search` → `search_web`, and `ask` → `ask_question`. `apply_patch` → `edit_file` applies only when `edit` is absent. Each request derives a reversible map from declarations, historical assistant calls and any named choice; original names reserve their identity, so an occupied alias conservatively leaves the OMP name unchanged rather than merging tools. Unknown/custom/MCP names stay unchanged. Declarations, historical calls, ID-paired responses and explicit allowed names use this map; all streamed partials, completed calls and final/error messages restore OMP names. This is names-only compatibility, not AGY argument/schema/execution compatibility: arguments, results, signatures and internal sessions remain unchanged.

System-prompt branding is applied only after the caller's awaited `onPayload` hook has finished. The host's `⁂ Role` introduction changes from `You are omp's trusted coding assistant.` to `You are Antigravity's trusted coding assistant.` in the outgoing `request.systemInstruction` only. Known ULW preset introductions beginning `You are omp, a coding agent` and the `OMP todo updates` / `OMP shell execution` headings receive the same branding; model names, specialist roles and all following instructions stay intact. The original context and hook-owned objects are not mutated. Commands, paths, package names, workflow and safety instructions, user messages and tool descriptions are not globally searched or rewritten. This does not import AGY's full system prompt or advertise its unimplemented runtime features.

The companion `omp-ulw` payload adapter recognizes `antigravity-cli` as a nested Google request and recognizes aliased `invoke_subagent` / `run_command` names for its existing guidance projection. Its `<omp-model-preset>` and `<omp-ulw-policy>` markers remain unchanged. A local HTTP receiver probe exercised the actual ULW turn-start/request hooks with Antigravity in both hook orders and main/subagent scopes: stale presets and main-session policies refreshed, specialist restrictions survived, and only the listed branding text changed after the hooks. The probe used fake credentials and was removed afterward; no upstream inference was performed.

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

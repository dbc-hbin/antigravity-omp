import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { createOAuthCodeLogin, resolveValue } from "./oauth-engine.js";
import { nativeAgentRequest, type ProtocolContext } from "./protocol";
import { clearNativeModels, rememberNativeModels } from "./native-models";
import { API_ID, streamAntigravity } from "./stream";
import { antigravityFetch } from "./transport";

const PROVIDER_ID = "google-antigravity";
const LABEL = "Google Antigravity (Gemini, Claude, GPT-OSS)";
let fetchInstallation: { previous: typeof fetch; current: typeof fetch; users: number } | undefined;

// Structural host contract keeps the extension independent of the CLI package.
interface ExtensionAPI {
  on(
    event: "session_start",
    handler: (
      event: unknown,
      context: {
        readonly model: Model<Api> | undefined;
        readonly modelRegistry: {
          readonly authStorage: { readonly credentials: { reload(): Promise<void> } };
          refreshDiscoverableProviders(providers: Iterable<string>, mode: "online"): Promise<void>;
          getAll(): Model<Api>[];
        };
      },
    ) => Promise<void>,
  ): void;
  on(
    event: "before_provider_request",
    handler: (event: { readonly payload: unknown }, context: ProtocolContext) => unknown,
  ): void;
  on(event: "session_shutdown", handler: () => void): void;
  setModel(model: Model<Api>): Promise<boolean>;
  registerProvider(
    id: string,
    config: {
      api?: Api;
      streamSimple?: typeof streamAntigravity;
      baseUrl?: string;
      models?: { id: string; api: Api; baseUrl: string }[];
      compat?: { antigravityClaudeToolMode: false; claudeThinkingBetaHeader: false };
      oauth: {
        name: string;
        login(callbacks: OAuthController): Promise<OAuthCredentials | string>;
        refreshToken(
          credentials: OAuthCredentials,
          signal?: AbortSignal,
        ): Promise<OAuthCredentials>;
        getApiKey(credentials: OAuthCredentials): string;
        modifyModels?(this: void, models: Model<Api>[]): Model<Api>[];
      };
    },
  ): void;
}

/** The auth policy's structured key: the JSON credential that the Antigravity transport parses per request. */
function structuredApiKey(credentials: OAuthCredentials): string {
  return JSON.stringify({
    apiEndpoint: credentials.apiEndpoint,
    token: credentials.access,
    enterpriseUrl: credentials.enterpriseUrl,
    projectId: credentials.projectId,
    refreshToken: credentials.refresh,
    expiresAt: credentials.expires,
    email: credentials.email,
    accountId: credentials.accountId,
  });
}

export default function antigravityExtension(pi: ExtensionAPI): void {
  // Official agy 1.5.6, SHA256 c55b821d...2dc753a; verified over HTTP/2.
  process.env.PI_AI_ANTIGRAVITY_VERSION = "1.5.6";
  process.env.PI_AI_ANTIGRAVITY_CL = "1018951551";
  const builtIn = getProviderDefinition(PROVIDER_ID);
  const policy = authPolicyFor(PROVIDER_ID);
  const rule = policy?.login;
  const refreshToken = builtIn?.refreshToken;
  if (!policy || rule?.kind !== "oauth-code" || !rule.clientId || !refreshToken) {
    throw new Error(`${PROVIDER_ID} has no built-in OAuth definition to restore`);
  }
  const clientId = rule.clientId;
  // Reuse the host's PKCE, state validation, token exchange and credential
  // handling with the URLs recovered from agy's authclient.getOAuthConfig.
  const login = createOAuthCodeLogin(
    {
      ...rule,
      authorizeUrl: { value: "https://accounts.google.com/o/oauth2/auth" },
      callback: { ...rule.callback, port: 0, hostname: "localhost", path: "/auth/callback" },
      userinfo: { ...rule.userinfo, url: "https://www.googleapis.com/oauth2/v2/userinfo" },
    },
    policy,
  );
  const compat = {
    antigravityClaudeToolMode: false,
    claudeThinkingBetaHeader: false,
  } as const;
  const oauth = {
    name: LABEL,
    login: (callbacks: OAuthController) =>
      login({ ...callbacks, fetch: callbacks.fetch ?? antigravityFetch }),
    refreshToken: (credentials: OAuthCredentials, signal?: AbortSignal) =>
      refreshToken(credentials, signal),
    getApiKey: structuredApiKey,
  };
  pi.registerProvider(PROVIDER_ID, { oauth });
  // All CCPA calls and this OAuth client's refresh requests use Go's HTTP
  // framing, after the host has decorated requests with proxy/TLS settings.
  if (!fetchInstallation) {
    const previous = globalThis.fetch;
    const current: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        const url = new URL(input instanceof Request ? input.url : input);
        const ccpa =
          headers.get("user-agent")?.startsWith("antigravity/hub/") &&
          url.pathname.startsWith("/v1internal");
        const token =
          url.href === "https://oauth2.googleapis.com/token" &&
          typeof init?.body === "string" &&
          new URLSearchParams(init.body).get("client_id") === (await resolveValue(clientId));
        const response = await (ccpa || token
          ? antigravityFetch(input, init)
          : previous(input, init));
        if (ccpa && url.pathname === "/v1internal:fetchAvailableModels" && response.ok) {
          const authorization = headers.get("authorization");
          if (authorization) rememberNativeModels(authorization, await response.clone().json());
        }
        return response;
      },
      { preconnect: previous.preconnect },
    );
    fetchInstallation = { previous, current, users: 0 };
    globalThis.fetch = current;
  }
  const installation = fetchInstallation;
  installation.users++;
  let released = false;
  pi.on("session_shutdown", () => {
    if (released) return;
    released = true;
    if (--installation.users === 0) {
      if (globalThis.fetch === installation.current) globalThis.fetch = installation.previous;
      fetchInstallation = undefined;
      clearNativeModels();
    }
  });
  pi.on("before_provider_request", (event, context) => nativeAgentRequest(event.payload, context));
  pi.on("session_start", async (_event, context) => {
    // AuthStorage was opened while the built-in provider was paused and
    // filtered its stored rows out of the pool. Re-adopt them after takeover.
    await context.modelRegistry.authStorage.credentials.reload();
    // The normalized disk cache lacks the native ModelDetails fields.
    await context.modelRegistry.refreshDiscoverableProviders([PROVIDER_ID], "online");
    const models = context.modelRegistry.getAll().filter((model) => model.provider === PROVIDER_ID);
    const first = models[0];
    if (!first) return;
    const nativeModels = new Map(models.map((model) => [model.id, model]));
    let registering = true;
    pi.registerProvider(PROVIDER_ID, {
      api: API_ID,
      streamSimple: streamAntigravity,
      baseUrl: first.baseUrl,
      models: models.map(({ id, baseUrl }) => ({ id, api: API_ID, baseUrl })),
      compat,
      oauth: {
        ...oauth,
        modifyModels: (rows) =>
          rows.map((row) => {
            if (row.provider !== PROVIDER_ID) return row;
            const original = nativeModels.get(row.id);
            // Registration materializes sparse bootstrap rows without roster
            // metadata. Restore the authoritative snapshot only during that
            // transaction; later projections own their current metadata even
            // when the native roster does not advertise a wire profile.
            const model = registering && original ? original : row;
            return { ...model, api: API_ID, compatConfig: { ...model.compatConfig, ...compat } };
          }),
      },
    });
    registering = false;
    if (context.model?.provider === PROVIDER_ID) {
      const selected = context.modelRegistry
        .getAll()
        .find((model) => model.provider === PROVIDER_ID && model.id === context.model?.id);
      if (selected) await pi.setModel(selected);
    }
  });
}

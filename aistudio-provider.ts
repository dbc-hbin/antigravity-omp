import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { ConfigurationError, GoogleApiError, ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import {
  buildGoogleGenerateContentParams,
  consumeGoogleStream,
  type GoogleSharedStreamOptions,
  type GoogleThinkingLevel,
} from "@oh-my-pi/pi-ai/providers/google-shared";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolChoice } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { z } from "zod";
import { AistudioRuntime } from "./aistudio-bridge";
import { parseCatalog, type StudioModel } from "./aistudio-catalog";
import { decodeResponse, encodeRequest } from "./aistudio-protocol";

const PROVIDER_ID = "google-aistudio";
const API_ID = "aistudio-native";
const ORIGIN = "https://aistudio.google.com";
const LABEL = "Google AI Studio (web session)";

const runtime = new AistudioRuntime();
const catalogs = new Map<string, readonly StudioModel[]>();

const accountSchema = z.object({ directory: z.string().min(1), email: z.string().min(1) });
const loginResultSchema = z.object({ directory: z.string().min(1), email: z.string().min(1) });
const catalogResultSchema = z.object({ models: z.unknown(), tier: z.unknown() });

interface ProviderModelRow {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly cost: StudioModel["cost"];
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly thinking?: StudioModel["thinking"];
}

export interface AistudioProviderConfig {
  readonly baseUrl: string;
  readonly api: string;
  readonly streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
  readonly oauth: {
    readonly name: string;
    login(callbacks: OAuthController): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
  };
  readonly fetchDynamicModels: (apiKey: string | undefined) => Promise<readonly ProviderModelRow[]>;
}

interface ExtensionAPI {
  on(event: "session_shutdown", handler: () => void): void;
  registerProvider(name: string, config: AistudioProviderConfig): void;
}

function accountFrom(apiKey: string | undefined): z.infer<typeof accountSchema> {
  if (!apiKey) throw new ConfigurationError("Google AI Studio is not logged in. Run /login to sign in.");
  return accountSchema.parse(JSON.parse(apiKey));
}

async function loadCatalog(
  account: z.infer<typeof accountSchema>,
  signal?: AbortSignal,
): Promise<readonly StudioModel[]> {
  const raw = catalogResultSchema.parse(
    await runtime.request({ method: "catalog", directory: account.directory }, signal),
  );
  const models = parseCatalog(raw.models, raw.tier);
  catalogs.set(account.directory, models);
  return models;
}

function toProviderRow(model: StudioModel): ProviderModelRow {
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinking ? { thinking: model.thinking } : {}),
  };
}

const THINKING_LEVELS: Readonly<Record<Effort, GoogleThinkingLevel>> = {
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
};

function toolChoiceFor(choice: ToolChoice | undefined): GoogleSharedStreamOptions["toolChoice"] {
  if (choice === undefined) return undefined;
  if (choice === "auto" || choice === "none") return choice;
  if (choice === "any" || choice === "required") return "any";
  if (typeof choice === "object" && "name" in choice) {
    return { mode: "ANY", allowedFunctionNames: [choice.name] };
  }
  return undefined;
}

function googleOptionsFor(options: SimpleStreamOptions | undefined): GoogleSharedStreamOptions {
  const reasoning = options?.reasoning;
  const toolChoice = toolChoiceFor(options?.toolChoice);
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(options?.topP !== undefined ? { topP: options.topP } : {}),
    ...(options?.topK !== undefined ? { topK: options.topK } : {}),
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(reasoning ? { thinking: { enabled: true, level: THINKING_LEVELS[reasoning] } } : {}),
  };
}

function emptyOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamAistudio(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const output = emptyOutput(model);
  void (async () => {
    try {
      const account = accountFrom(typeof options?.apiKey === "string" ? options.apiKey : undefined);
      const models = catalogs.get(account.directory) ?? (await loadCatalog(account, options?.signal));
      const studio = models.find(candidate => candidate.id === model.id);
      if (!studio) {
        throw new ConfigurationError(`Model ${model.id} is not served for this Google AI Studio account.`);
      }
      // OMP's Gemini builder reads only wire-neutral fields (id, input, reasoning,
      // limits, compat); the API tag is only the type-level match for its signature.
      const googleModel = model as Model<"google-generative-ai">;
      const params = buildGoogleGenerateContentParams(googleModel, context, googleOptionsFor(options));
      const encoded = encodeRequest(studio, params);
      const response = await runtime.generate(
        {
          method: "generate",
          directory: account.directory,
          model: model.id,
          body: encoded.body,
          prompt: encoded.prompt,
        },
        options?.signal,
      );
      if (!response.ok) {
        throw new GoogleApiError(`Google AI Studio returned HTTP ${response.status}.`, response.status);
      }
      if (!response.body) {
        throw new ProviderResponseError("Google AI Studio returned an empty response body.", {
          provider: PROVIDER_ID,
          kind: "empty-body",
        });
      }
      stream.push({ type: "start", partial: output });
      await consumeGoogleStream({
        googleStream: decodeResponse(response.body, undefined, params),
        output,
        stream,
        model: googleModel,
        options: options?.signal ? { signal: options.signal } : undefined,
      });
      if (output.stopReason !== "stop" && output.stopReason !== "length" && output.stopReason !== "toolUse") {
        throw new ProviderResponseError(output.errorMessage ?? "Unexpected AI Studio stop reason.", {
          provider: PROVIDER_ID,
          kind: "output",
        });
      }
      stream.push({ type: "done", reason: output.stopReason, message: output });
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      output.stopReason = aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: output });
    }
  })();
  return stream;
}

/** Registers Google AI Studio through its own web-session runtime; no HTTP proxy is started. */
export default function aistudioExtension(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: ORIGIN,
    api: API_ID,
    streamSimple: streamAistudio,
    oauth: {
      name: LABEL,
      async login(callbacks) {
        callbacks.onProgress?.("Opening Google AI Studio in an isolated browser...");
        const result = loginResultSchema.parse(
          await runtime.request({ method: "login" }, callbacks.signal, message => callbacks.onProgress?.(message)),
        );
        return {
          access: "",
          refresh: "",
          expires: Number.MAX_SAFE_INTEGER,
          email: result.email,
          accountId: result.directory,
        };
      },
      getApiKey(credentials) {
        return JSON.stringify({ directory: credentials.accountId, email: credentials.email });
      },
    },
    async fetchDynamicModels(apiKey) {
      const account = accountFrom(apiKey);
      const models = await loadCatalog(account);
      return models.map(toProviderRow);
    },
  });
  pi.on("session_shutdown", () => {
    void runtime.close();
  });
}

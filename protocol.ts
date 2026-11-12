import type { Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { envelope } from "./wire";

export interface ProtocolContext {
  readonly model: Model | undefined;
  readonly sessionManager: {
    getSessionId(): string;
    getBranch(): readonly {
      readonly type: string;
      readonly message?: {
        readonly role: string;
        readonly provider?: string;
        readonly model?: string;
      };
    }[];
  };
}

/** Adapt the inherited Gemini builder to agy's modelapiccpa agent path. */
export function nativeAgentRequest(payload: unknown, context: ProtocolContext): unknown {
  if (
    context.model?.provider !== "google-antigravity" ||
    (context.model.kind !== undefined && context.model.kind !== "chat")
  ) {
    return payload;
  }
  const parsed = envelope.parse(payload);
  const requestId = parsed.requestId.split("/");
  const cascadeId = context.sessionManager.getSessionId();
  requestId[1] = cascadeId;
  const labels: Record<string, string> = { ...parsed.request.labels, cascade_id: cascadeId };
  // Primary CLI conversations use their cascade as the root. Preserve an
  // explicit parent root when this is a child conversation.
  if (!labels.root_cascade_id || labels.root_cascade_id === parsed.request.labels.cascade_id)
    labels.root_cascade_id = cascadeId;
  let usedClaude = labels.used_claude === "true";
  let usedClaudeConservative = labels.used_claude_conservative === "true";
  let usedNonGemini = labels.used_non_gemini_model === "true";
  for (const entry of context.sessionManager.getBranch()) {
    const message = entry.message;
    if (message?.role !== "assistant" || !message.provider || !message.model) continue;
    const identity = classifyModel(message.provider, message.model);
    usedClaude ||= identity.class === "anthropic";
    usedClaudeConservative ||= identity.class === "anthropic" || identity.class === "unknown";
    usedNonGemini ||= identity.class !== "gemini";
  }
  labels.used_claude = String(usedClaude);
  labels.used_claude_conservative = String(usedClaudeConservative);
  labels.used_non_gemini_model = String(usedNonGemini);
  // The CCPA agent adapter hashes an empty session-source slot with FNV-1a.
  // Confirmed in both Gemini and Claude agy 1.5.6 request captures.
  const sessionId = BigInt.asIntN(64, 0xcbf29ce484222325n).toString();
  return {
    ...parsed,
    requestId: requestId.join("/"),
    request: {
      ...parsed.request,
      sessionId,
      labels: Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))),
    },
    // AGENT purpose enum 5 -> "agent".
    requestType: "agent",
  };
}

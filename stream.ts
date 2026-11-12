import {
  getEnvApiKey,
  isArkSchema,
  streamSimple,
  type CustomStreamSimpleFn,
  type ImageContent,
} from "@oh-my-pi/pi-ai";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { mapEffortToGoogleThinkingLevel } from "@oh-my-pi/pi-catalog/model-thinking";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { z } from "zod";
import { nativeModelDetails } from "./native-models";
import { envelope, nativeWireRequest } from "./wire";

export const API_ID = "antigravity-cli";
const identity = z.object({ token: z.string() });
const part = z.record(z.string(), z.json());
type Part = z.infer<typeof part>;

function signature(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const encoded = value.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new ConfigurationError("Invalid base64 Antigravity thought signature");
  return Buffer.from(encoded, "base64").toString("base64") || undefined;
}

function inlineImage(image: ImageContent): Part {
  return {
    inlineData: {
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
      ...(image.data ? { data: image.data } : {}),
    },
  };
}

/** Preserve original options and messages before the shared CCA builder rewrites them. */
export const streamAntigravity: CustomStreamSimpleFn = (model, context, options) =>
  streamSimple(buildModel({ ...toModelSpec(model), api: "google-gemini-cli" }), context, {
    ...options,
    onPayload: async (payload) => {
      const parsed = envelope.parse(payload);
      const credentials = identity.parse(
        JSON.parse(z.string().parse(options?.apiKey ?? getEnvApiKey(model.provider))),
      );
      const details = nativeModelDetails(`Bearer ${credentials.token}`, parsed.model);
      const enabled =
        details.supportsThinking &&
        (model.thinking?.requiresEffort === true ||
          (!options?.disableReasoning && !options?.forceReasoningOff));
      const effort = options?.reasoning;
      // Options level wins over the roster level, which wins over its budget.
      const level =
        enabled && effort && model.thinking?.mode === "google-level"
          ? mapEffortToGoogleThinkingLevel(effort, model)
          : details.thinkingLevel;
      const thinkingConfig = {
        ...(enabled ? { includeThoughts: true } : {}),
        ...(level
          ? { thinkingLevel: level }
          : { thinkingBudget: enabled ? details.thinkingBudget : details.minThinkingBudget }),
      };
      const maxOutputTokens = options?.maxTokens ?? details.maxOutputTokens;
      const contents: { role: string; parts: Part[] }[] = [];
      const callNames = new Map<string, string>();
      let previousWasTool = false;
      for (const message of context.messages) {
        const parts: Part[] = [];
        if (message.role === "toolResult") {
          const name = callNames.get(message.toolCallId);
          if (name === undefined)
            throw new ConfigurationError(`No preceding call for tool result ${message.toolCallId}`);
          const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          const images = message.content.filter((block) => block.type === "image").map(inlineImage);
          const response: Part = {
            ...(message.toolCallId ? { id: message.toolCallId } : {}),
            ...(name ? { name } : {}),
            response: { [message.isError ? "error" : "output"]: text },
            ...(images.length ? { parts: images } : {}),
          };
          parts.push({ functionResponse: response });
          if (previousWasTool) contents[contents.length - 1]?.parts.push(...parts);
          else
            contents.push({
              role:
                details.apiProvider === 26 ||
                details.apiProvider === "API_PROVIDER_ANTHROPIC_VERTEX"
                  ? "user"
                  : "model",
              parts,
            });
          previousWasTool = true;
          continue;
        }
        previousWasTool = false;
        if (message.role === "assistant") {
          let messageSignature: string | undefined;
          for (const block of message.content) {
            if (block.type === "thinking") messageSignature ||= signature(block.thinkingSignature);
          }
          for (const block of message.content) {
            if (block.type === "text") messageSignature ||= signature(block.textSignature);
          }
          const thinking = message.content
            .filter((block) => block.type === "thinking")
            .map((block) => block.thinking)
            .join("");
          const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          if (thinking.trim() && (messageSignature || details.supportsThoughtCirculation))
            parts.push({ text: thinking, thought: true });
          if (text.trim()) parts.push({ text });
          for (const block of message.content) {
            if (block.type === "toolCall") {
              callNames.set(block.id, block.name);
              const thoughtSignature = signature(block.thoughtSignature);
              parts.push({
                functionCall: {
                  ...(block.id ? { id: block.id } : {}),
                  ...(block.name ? { name: block.name } : {}),
                  args: z.record(z.string(), z.json()).parse(block.arguments),
                },
                ...(thoughtSignature ? { thoughtSignature } : {}),
              });
            }
          }
          if (parts.length && details.supportsThinking && messageSignature) {
            const target = parts.find((value) => !value.thought) ?? parts[0];
            if (target) target.thoughtSignature = messageSignature;
          }
        } else if (typeof message.content === "string") {
          if (message.content) parts.push({ text: message.content });
        } else {
          const text = message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          if (text) parts.push({ text });
          for (const block of message.content) {
            if (block.type === "image") parts.push(inlineImage(block));
          }
        }
        if (parts.length)
          contents.push({ role: message.role === "assistant" ? "model" : "user", parts });
      }
      const request = {
        ...parsed.request,
        labels: { ...parsed.request.labels, model_enum: details.model },
        generationConfig: {
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          thinkingConfig,
        },
        systemInstruction: {
          role: "user",
          parts: [
            {
              text: Array.isArray(context.systemPrompt)
                ? context.systemPrompt.join("\n\n")
                : (context.systemPrompt ?? ""),
            },
          ],
        },
        ...(contents.length ? { contents } : {}),
        tools: context.tools?.map((tool) => ({
          functionDeclarations: [
            {
              name: tool.name,
              description: tool.description,
              parameters: z.json().parse(
                JSON.parse(
                  JSON.stringify(
                    isArkSchema(tool.parameters)
                      ? tool.parameters.toJsonSchema({
                          target: "draft-2020-12",
                          fallback: (value) => value.base,
                        })
                      : tool.parameters,
                  ),
                ),
              ),
            },
          ],
        })),
      };
      if (!contents.length) delete request.contents;
      // Replace the inherited tool policy even when no declarations are present.
      delete request.toolConfig;
      const choice = options?.toolChoice;
      if (choice) {
        let mode: string;
        let names: string[] | undefined;
        if (typeof choice === "string") {
          if (choice === "auto") mode = "VALIDATED";
          else if (choice === "required" || choice === "any") mode = "ANY";
          else if (choice === "none") mode = "NONE";
          else throw new ConfigurationError(`Unsupported native tool choice: ${String(choice)}`);
        } else {
          if (choice.type === "computer")
            throw new ConfigurationError("Native Antigravity tool choice requires a function");
          const name = "function" in choice ? choice.function.name : choice.name;
          mode = "ANY";
          if (name) names = [name];
        }
        request.toolConfig = {
          functionCallingConfig: { mode, ...(names ? { allowedFunctionNames: names } : {}) },
        };
      }
      const native = nativeWireRequest({ ...parsed, request });
      return (await options?.onPayload?.(native, model)) ?? native;
    },
  });

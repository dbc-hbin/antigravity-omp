import {
  createAssistantMessageEventStream,
  getEnvApiKey,
  isArkSchema,
  streamSimple,
  type AssistantMessage,
  type Context,
  type CustomStreamSimpleFn,
  type ImageContent,
  type SimpleStreamOptions,
  type Tool,
  type ToolCall,
} from "@oh-my-pi/pi-ai";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { mapEffortToGoogleThinkingLevel } from "@oh-my-pi/pi-catalog/model-thinking";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { z } from "zod";
import { toolContracts } from "./tool-contracts";
import { nativeModelDetails } from "./native-models";
import { envelope, nativeWireRequest } from "./wire";

export const API_ID = "antigravity-cli";
const identity = z.object({ token: z.string() });
const part = z.record(z.string(), z.json());
type Part = z.infer<typeof part>;
const contractByHost = new Map(toolContracts.map((tool) => [tool.hostName, tool]));
const nativeToolAliases: readonly (readonly [string, string])[] = [
  ["bash", "run_command"],
  ["edit", "edit_file"],
  ["task", "invoke_subagent"],
  ["web_search", "search_web"],
  ["ask", "ask_question"],
  ["apply_patch", "edit_file"],
];
const schemaFields = z.looseObject({
  properties: part.optional(),
  required: z.array(z.string()).optional(),
});
const stringProperty = z.looseObject({ type: z.literal("string") });

type ContractRoute = {
  readonly contract: (typeof toolContracts)[number];
  readonly intent?: {
    readonly schema: z.infer<typeof stringProperty>;
    readonly required: boolean;
  };
};

function toolParameters(tool: Tool) {
  return z.json().parse(
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
  );
}

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

function toolRoutes(context: Context, choice: SimpleStreamOptions["toolChoice"]) {
  const originals = new Set(context.tools?.map((tool) => tool.name));
  for (const message of context.messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "toolCall") originals.add(block.name);
    }
  }
  if (choice && typeof choice !== "string" && choice.type !== "computer") {
    const name = "function" in choice ? choice.function.name : choice.name;
    if (name) originals.add(name);
  }
  const outgoing = new Map<string, string>();
  const incoming = new Map<string, string>();
  const contracts = new Map<string, ContractRoute>();
  for (const [original, alias] of nativeToolAliases) {
    // Reserve every original identity, including history-only/custom tools.
    if (
      !originals.has(original) ||
      originals.has(alias) ||
      (original === "apply_patch" && originals.has("edit"))
    )
      continue;
    outgoing.set(original, alias);
    incoming.set(alias, original);
  }
  for (const tool of context.tools ?? []) {
    const contract = contractByHost.get(tool.name);
    if (!contract || originals.has(contract.declaration.name)) continue;
    // OMP's device-only write is not a filesystem capability. A pruned
    // description also doesn't establish that filesystem write is available.
    if (
      tool.name === "write" &&
      (!tool.description.trim() || tool.description.includes("xd://<tool>"))
    )
      continue;
    const host = schemaFields.safeParse(toolParameters(tool));
    if (!host.success) continue;
    const field = host.data.properties?.i;
    if (
      host.data.required?.some((name) =>
        name === "i" ? field === undefined : !contract.requiredHostArguments.includes(name),
      )
    )
      continue;
    let intent: ContractRoute["intent"];
    if (field !== undefined) {
      const parsed = stringProperty.safeParse(field);
      if (!parsed.success) continue;
      intent = { schema: parsed.data, required: host.data.required?.includes("i") ?? false };
    }
    const alias = contract.declaration.name;
    contracts.set(tool.name, { contract, ...(intent ? { intent } : {}) });
    incoming.set(alias, tool.name);
  }
  return {
    declarations(tool: Tool) {
      // Keep the full host surface (including URI targets and complex searches)
      // alongside the narrower native alias, not behind a validator fallback.
      const host = {
        name: outgoing.get(tool.name) ?? tool.name,
        description: tool.description,
        parameters: toolParameters(tool),
      };
      const route = contracts.get(tool.name);
      if (!route) return [host];
      const { declaration } = route.contract;
      const schema = schemaFields.parse(declaration.parameters);
      const parameters = route.intent
        ? {
            ...schema,
            properties: { ...schema.properties, i: route.intent.schema },
            required: route.intent.required ? [...(schema.required ?? []), "i"] : schema.required,
          }
        : schema;
      return [{ name: declaration.name, description: declaration.description, parameters }, host];
    },
    allowedNames(name: string) {
      const route = contracts.get(name);
      return route ? [route.contract.declaration.name, name] : [outgoing.get(name) ?? name];
    },
    async replay(call: ToolCall, cwd: string) {
      const route = contracts.get(call.name);
      if (!route) return { name: outgoing.get(call.name) ?? call.name, args: call.arguments };
      // A host read's :raw suffix can be a literal filename. Today's
      // filesystem cannot establish what that suffix meant in an old call.
      if (
        call.name === "read" &&
        (!("antigravityReadPath" in call) || call.antigravityReadPath !== call.arguments.path)
      )
        return { name: call.name, args: call.arguments };
      try {
        const { i, ...withoutIntent } = call.arguments;
        const value = i ?? call.intent;
        if (
          route.intent &&
          (value === undefined ? route.intent.required : typeof value !== "string")
        ) {
          return { name: call.name, args: call.arguments };
        }
        const args = await route.contract.encode(route.intent ? withoutIntent : call.arguments, cwd);
        return {
          name: route.contract.declaration.name,
          args: { ...args, ...(route.intent && value !== undefined ? { i: value } : {}) },
        };
      } catch (error) {
        if (error instanceof z.ZodError || error instanceof ConfigurationError)
          return { name: call.name, args: call.arguments };
        throw error;
      }
    },
    async restore(call: ToolCall, cwd: string): Promise<ToolCall> {
      const name = incoming.get(call.name);
      if (name === undefined) return call;
      const route = contracts.get(name);
      if (!route) return { ...call, name };
      const { i, ...withoutIntent } = call.arguments;
      try {
        if (route.intent && (i === undefined ? route.intent.required : typeof i !== "string"))
          throw new ConfigurationError("Invalid tool intent: i must be a string");
        const args = await route.contract.decode(
          route.intent ? withoutIntent : call.arguments,
          cwd,
        );
        const readPath = name === "read" && typeof args.path === "string" ? args.path : undefined;
        return {
          ...call,
          name,
          arguments: { ...args, ...(route.intent && i !== undefined ? { i } : {}) },
          ...(readPath === undefined ? {} : { antigravityReadPath: readPath }),
        };
      } catch (error) {
        if (!(error instanceof ConfigurationError)) throw error;
        // OMP's provider argument-error marker is rejected before any tool
        // runs, even with lenient validation. Keep the call ID for its result.
        return { ...call, name, arguments: { __parseError: error.message } };
      }
    },
  };
}

/** Change only identity text in the final system instruction, after other extensions. */
function nativeBranding(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("request" in payload)) return payload;
  const request = payload.request;
  if (!request || typeof request !== "object" || !("systemInstruction" in request)) return payload;
  const instruction = request.systemInstruction;
  if (!instruction || typeof instruction !== "object" || !("parts" in instruction)) return payload;
  if (!Array.isArray(instruction.parts)) return payload;
  let changed = false;
  const parts = instruction.parts.map((part: unknown) => {
    if (!part || typeof part !== "object" || !("text" in part) || typeof part.text !== "string")
      return part;
    const text = part.text
      .replace(
        /^(⁂ Role\r?\n)You are omp's trusted coding assistant\.(?=\r?$)/m,
        "$1You are Antigravity's trusted coding assistant.",
      )
      .replace(/^You are omp(?=, a coding agent[. ])/m, "You are Antigravity")
      .replace(/^(## )OMP (todo updates|shell execution)(?=\r?$)/gm, "$1Antigravity $2");
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed
    ? { ...payload, request: { ...request, systemInstruction: { ...instruction, parts } } }
    : payload;
}

/** Preserve original options and messages before the shared CCA builder rewrites them. */
export const streamAntigravity: CustomStreamSimpleFn = (model, context, options) => {
  const routes = toolRoutes(context, options?.toolChoice);
  const cwd = options?.cwd ?? process.cwd();
  const source = streamSimple(buildModel({ ...toModelSpec(model), api: "google-gemini-cli" }), context, {
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
              const { name, args } = await routes.replay(block, cwd);
              callNames.set(block.id, name);
              const thoughtSignature = signature(block.thoughtSignature);
              parts.push({
                functionCall: {
                  ...(block.id ? { id: block.id } : {}),
                  ...(name ? { name } : {}),
                  args: part.parse(args),
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
        tools: context.tools?.flatMap((tool) =>
          routes.declarations(tool).map(({ name, description, parameters }) => ({
            functionDeclarations: [{ name, description, parameters: z.json().parse(parameters) }],
          })),
        ),
      };
      if (!contents.length) delete request.contents;
      // Replace the inherited tool policy even when no declarations are present.
      delete request.toolConfig;
      const choice = options?.toolChoice;
      if (choice) {
        let mode: string;
        let allowedFunctionNames: string[] | undefined;
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
          if (name) allowedFunctionNames = routes.allowedNames(name);
        }
        request.toolConfig = {
          functionCallingConfig: { mode, ...(allowedFunctionNames ? { allowedFunctionNames } : {}) },
        };
      }
      const native = nativeWireRequest({ ...parsed, request });
      return nativeBranding((await options?.onPayload?.(native, model)) ?? native);
    },
  });
  const output = createAssistantMessageEventStream();
  const restoredCalls = new WeakMap<ToolCall, Promise<ToolCall>>();
  const restoreCall = async (block: ToolCall): Promise<ToolCall> => {
    let restored = restoredCalls.get(block);
    if (!restored) {
      restored = routes.restore(block, cwd);
      restoredCalls.set(block, restored);
    }
    return { ...(await restored) };
  };
  const restore = async (message: AssistantMessage): Promise<AssistantMessage> => ({
    ...message,
    // Providers reuse their partial message/array/calls; never rename those in place.
    content: await Promise.all(
      message.content.map(async (block) => (block.type === "toolCall" ? restoreCall(block) : block)),
    ),
  });
  output.forwardLocalWorkFrom(source);
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === "done") output.push({ ...event, message: await restore(event.message) });
        else if (event.type === "error")
          output.push({ ...event, error: await restore(event.error) });
        else if (event.type === "toolcall_end")
          output.push({
            ...event,
            partial: await restore(event.partial),
            toolCall: await restoreCall(event.toolCall),
          });
        else if (event.type === "toolcall_delta") {
          const partial = await restore(event.partial);
          const block = partial.content[event.contentIndex];
          output.push({
            ...event,
            partial,
            delta: block?.type === "toolCall" ? JSON.stringify(block.arguments) : event.delta,
          });
        } else output.push({ ...event, partial: await restore(event.partial) });
      }
      if (output.resultSettled) output.end();
      else output.end(await restore(await source.result()));
    } catch (error) {
      output.fail(error);
    } finally {
      output.forwardLocalWorkFrom(undefined);
    }
  })();
  return output;
};

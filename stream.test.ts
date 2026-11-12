import { expect, test } from "bun:test";
import {
  streamSimple,
  type AssistantMessage,
  type Context,
  type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { loadExtension } from "./extension-fixture";
import { rememberNativeModels } from "./native-models";

const image = {
  type: "image" as const,
  mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHZkAAAAASUVORK5CYII=",
  url: "https://example.invalid/image.png",
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    api: "google-gemini-cli",
    provider: "google-antigravity",
    model: "gemini-3.8-flash",
    content,
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function capture(
  context: Context,
  options?: SimpleStreamOptions,
  details: Record<string, unknown> = {},
  modelId = "gemini-3.8-flash",
) {
  const { projected, payloadHook } = await loadExtension();
  const source = projected.find((model) => model.id === modelId);
  if (!source) throw new Error("Missing fixture model");
  const row = {
    model: "MODEL_PLACEHOLDER_M320",
    apiProvider: 24,
    maxOutputTokens: 65536,
    supportsThinking: true,
    thinkingBudget: 1000,
    ...details,
  };
  rememberNativeModels("Bearer local-test-token", {
    models: {
      "gemini-3.8-flash-low": row,
      "gemini-3.8-flash-high": row,
      "claude-sonnet-5-5-high": row,
    },
  });
  let body: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      body = await request.json();
      return new Response(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    const model = { ...source, baseUrl: server.url.origin };
    const stream = streamSimple(model, context, {
      apiKey: JSON.stringify({ token: "local-test-token", projectId: "test-project" }),
      ...options,
      onPayload: (payload) => {
        if (typeof payloadHook !== "function") throw new Error("Missing provider hook");
        return payloadHook(
          { payload },
          { model, sessionManager: { getSessionId: () => "session", getBranch: () => [] } },
        );
      },
    });
    for await (const _event of stream) {
      // Consume the actual provider stream, including errors.
    }
    return { body, result: await stream.result() };
  } finally {
    await server.stop(true);
  }
}

test("uses the selected account roster and preserves explicit total output limits", async () => {
  const reasoning = THINKING_EFFORTS.find((effort) => effort === "high");
  if (!reasoning) throw new Error("Missing high thinking effort");
  const { body, result } = await capture(
    { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] },
    { reasoning, maxTokens: 2048 },
    { model: "MODEL_PLACEHOLDER_M318", maxOutputTokens: 98765, thinkingBudget: -1 },
  );
  expect(result.content).toContainEqual({ type: "text", text: "OK" });
  expect(body).toMatchObject({
    model: "gemini-3.8-flash-high",
    request: {
      labels: { model_enum: "MODEL_PLACEHOLDER_M318" },
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
      },
    },
  });
});

test.each([
  { choice: "none" as const, mode: "NONE" },
  { choice: "auto" as const, mode: "VALIDATED" },
  { choice: "required" as const, mode: "ANY" },
])("retains explicit $choice even without tool declarations", async ({ choice, mode }) => {
  const { body, result } = await capture(
    { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] },
    { toolChoice: choice },
  );
  expect(result.stopReason).toBe("stop");
  expect(body).toMatchObject({
    request: { toolConfig: { functionCallingConfig: { mode } } },
  });
  expect(body).not.toHaveProperty("request.tools");
  expect(body).toHaveProperty("request.contents", [
    { role: "user", parts: [{ text: "Reply OK" }] },
  ]);
});

test("does not borrow a different account's native metadata", async () => {
  const { body, result } = await capture(
    { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] },
    { apiKey: JSON.stringify({ token: "another-account-token", projectId: "test-project" }) },
  );
  expect(body).toBeUndefined();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("Native Antigravity metadata");
});

test("converts original schemas without inherited CCA combiner or nullable rewriting", async () => {
  const { body, result } = await capture(
    {
      messages: [{ role: "user", content: "Inspect", timestamp: 0 }],
      tools: [
        {
          name: "inspect",
          description: "",
          parameters: {
            type: "object",
            title: "Dropped title",
            additionalProperties: false,
            required: ["choice", "free", "nonexistent"],
            properties: {
              choice: {
                anyOf: [{ type: "string" }, { type: "null" }],
                nullable: true,
                default: null,
              },
              free: {},
              value: {
                type: "string",
                enum: ["x", 9],
                minLength: 3.8,
                maxLength: 0,
                default: "",
              },
            },
          },
        },
      ],
    },
    undefined,
    { thinkingLevel: 5 },
  );
  expect(result.stopReason).toBe("stop");
  expect(body).toHaveProperty("request.tools", [
    {
      functionDeclarations: [
        {
          name: "inspect",
          parameters: {
            type: 6,
            required: ["choice", "free"],
            properties: {
              choice: { default: null },
              free: {},
              value: { type: 1, enum: ["x", ""], minLength: "3", default: "" },
            },
          },
        },
      ],
    },
  ]);
});

test.each([
  { apiProvider: 24, role: "model" },
  { apiProvider: 26, role: "user" },
])("replays native tool results for ApiProvider $apiProvider", async ({ apiProvider, role }) => {
  const { body, result } = await capture(
    {
      messages: [
        { role: "user", content: " \n", timestamp: 0 },
        assistant([
          { type: "thinking", thinking: " Plan ", thinkingSignature: "c2ln" },
          {
            type: "toolCall",
            id: "call/one",
            name: "inspect",
            arguments: { type: "object" },
            thoughtSignature: "Y2FsbA==",
          },
          { type: "toolCall", id: "call/two", name: "read", arguments: {} },
        ]),
        {
          role: "toolResult",
          toolCallId: "call/one",
          toolName: "outdated-name",
          content: [image],
          isError: false,
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call/two",
          toolName: "read",
          content: [{ type: "text", text: "" }],
          isError: true,
          timestamp: 0,
        },
      ],
    },
    undefined,
    { apiProvider },
  );
  expect(result.stopReason).toBe("stop");
  expect(body).toHaveProperty("request.systemInstruction", { role: "user", parts: [{ text: "" }] });
  expect(body).toHaveProperty("request.contents", [
    { role: "user", parts: [{ text: " \n" }] },
    {
      role: "model",
      parts: [
        { text: " Plan ", thought: true },
        {
          functionCall: { id: "call/one", name: "inspect", args: { type: "object" } },
          thoughtSignature: "c2ln",
        },
        { functionCall: { id: "call/two", name: "read", args: {} } },
      ],
    },
    {
      role,
      parts: [
        {
          functionResponse: {
            id: "call/one",
            name: "inspect",
            response: { output: "" },
            parts: [{ inlineData: { mimeType: image.mimeType, data: image.data } }],
          },
        },
        { functionResponse: { id: "call/two", name: "read", response: { error: "" } } },
      ],
    },
  ]);
});

test("drops unsigned thought replay without circulation and does not synthesize signatures", async () => {
  const { body, result } = await capture({
    messages: [
      assistant([
        { type: "thinking", thinking: "private plan" },
        { type: "text", text: "done" },
        { type: "toolCall", id: "call", name: "read", arguments: {} },
      ]),
    ],
  });
  expect(result.stopReason).toBe("stop");
  expect(body).toHaveProperty("request.contents", [
    {
      role: "model",
      parts: [{ text: "done" }, { functionCall: { id: "call", name: "read", args: {} } }],
    },
  ]);
});

test("retains unsigned thought replay when the roster enables circulation", async () => {
  const { body, result } = await capture(
    { messages: [assistant([{ type: "thinking", thinking: " Plan " }])] },
    undefined,
    { supportsThoughtCirculation: true, supportsThinking: false },
  );
  expect(result.stopReason).toBe("stop");
  expect(body).toHaveProperty("request.contents", [
    { role: "model", parts: [{ text: " Plan ", thought: true }] },
  ]);
  expect(body).toHaveProperty("request.generationConfig.thinkingConfig", { thinkingBudget: 0 });
});

test("rejects an invalid encoded thought signature before generation", async () => {
  const { body, result } = await capture({
    messages: [assistant([{ type: "text", text: "done", textSignature: "not base64" }])],
  });
  expect(body).toBeUndefined();
  expect(result.errorMessage).toContain("Invalid base64 Antigravity thought signature");
});

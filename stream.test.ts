import { expect, test } from "bun:test";
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
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

function sse(parts: Record<string, unknown>[], finishReason = "STOP") {
  return `data: ${JSON.stringify({
    response: { candidates: [{ content: { role: "model", parts }, finishReason }] },
  })}\n\n`;
}

async function capture(
  context: Context,
  options?: SimpleStreamOptions,
  details: Record<string, unknown> = {},
  modelId = "gemini-3.8-flash",
  response = 'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
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
      return new Response(response, { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    const model = { ...source, baseUrl: server.url.origin };
    const stream = streamSimple(model, context, {
      apiKey: JSON.stringify({ token: "local-test-token", projectId: "test-project" }),
      ...options,
      onPayload: async (payload) => {
        if (typeof payloadHook !== "function") throw new Error("Missing provider hook");
        const hooked = await payloadHook(
          { payload },
          { model, sessionManager: { getSessionId: () => "session", getBranch: () => [] } },
        );
        return (await options?.onPayload?.(hooked, model)) ?? hooked;
      },
    });
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return { body, events, result: await stream.result() };
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
        { functionCall: { id: "call/two", name: "read_file", args: {} } },
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
        { functionResponse: { id: "call/two", name: "read_file", response: { error: "" } } },
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
      parts: [{ text: "done" }, { functionCall: { id: "call", name: "read_file", args: {} } }],
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

test.each(["\n", "\r\n"])("changes only the host identity in the outgoing system prompt (%j)", async (newline) => {
  const identity = ["⁂ Role", "You are omp's trusted coding assistant."].join(newline);
  const retained = [
    "Follow all permission and sandbox checks.",
    "Use omp --version and ~/.omp; package @oh-my-pi/pi-ai.",
    "The omp-ulw workflow and OMP-native tool contracts remain in force.",
    'Quoted example: "You are omp\'s trusted coding assistant."',
  ].join(newline);
  const context: Context = {
    systemPrompt: [identity, retained],
    messages: [{ role: "user", content: identity, timestamp: 0 }],
    tools: [{ name: "inspect", description: identity, parameters: { type: "object" } }],
  };
  const before = structuredClone(context);
  const { body, result } = await capture(context);
  expect(result.stopReason).toBe("stop");
  expect(body).toMatchObject({
    request: {
      systemInstruction: {
        role: "user",
        parts: [{ text: `${identity.replace("omp's", "Antigravity's")}\n\n${retained}` }],
      },
      contents: [{ role: "user", parts: [{ text: identity }] }],
      tools: [{ functionDeclarations: [{ name: "inspect", description: identity }] }],
    },
  });
  expect(context).toEqual(before);
});

test("brands the final extension-rewritten prompt without changing hook-owned data", async () => {
  const systemInstruction = {
    role: "user",
    parts: [
      { text: "⁂ Role\nYou are omp's trusted coding assistant.", metadata: "keep" },
      { text: "ULW role, execution rules and omp commands must remain unchanged." },
    ],
    marker: "keep",
  };
  const before = structuredClone(systemInstruction);
  const { body, result } = await capture(
    { systemPrompt: ["Original context"], messages: [{ role: "user", content: "Inspect", timestamp: 0 }] },
    {
      onPayload: async (payload) => {
        await Promise.resolve();
        const value = payload as { request: Record<string, unknown> };
        return { ...value, request: { ...value.request, systemInstruction } };
      },
    },
  );
  expect(result.stopReason).toBe("stop");
  expect(body).toHaveProperty("request.systemInstruction", {
    ...systemInstruction,
    parts: [
      { text: "⁂ Role\nYou are Antigravity's trusted coding assistant.", metadata: "keep" },
      systemInstruction.parts[1],
    ],
  });
  expect(systemInstruction).toEqual(before);
});

test.each([".", " running on Gemini 4 Argon."])("preserves ULW roles, markers and policy while branding its introduction (%s)", async (suffix) => {
  const prompt = [
    "<omp-model-preset>",
    `You are omp, a coding agent${suffix} Keep the user's intended goal.`,
    "## OMP todo updates",
    "Never make a todo-only turn.",
    "## OMP shell execution",
    "Preserve OMP shell state, permissions and task lifecycles.",
    "</omp-model-preset>",
    "<omp-ulw-policy><ultrawork-mode>Keep working until verified.</ultrawork-mode></omp-ulw-policy>",
    "Specialist role: researcher. Do not edit files.",
    "Run omp --version; preserve ~/.omp and @oh-my-pi/pi-ai.",
  ].join("\n");
  const { body, result } = await capture({
    systemPrompt: [prompt],
    messages: [{ role: "user", content: prompt, timestamp: 0 }],
  });
  expect(result.stopReason).toBe("stop");
  expect(body).toHaveProperty("request.systemInstruction.parts", [{
    text: prompt
      .replace("You are omp,", "You are Antigravity,")
      .replace("## OMP todo updates", "## Antigravity todo updates")
      .replace("## OMP shell execution", "## Antigravity shell execution"),
  }]);
  expect(body).toHaveProperty("request.contents", [{ role: "user", parts: [{ text: prompt }] }]);
});

test("aliases only outbound tool names across declarations, history, paired results and choice", async () => {
  const originals = [
    "read", "bash", "write", "edit", "task", "web_search", "ask", "apply_patch", "inspect", "mcp__server__read",
  ];
  const native = [
    "read_file", "run_command", "write_file", "edit_file", "invoke_subagent", "search_web", "ask_question", "apply_patch", "inspect", "mcp__server__read",
  ];
  const args = { name: "read", text: "bash read_file", nested: { tool: "write" } };
  const context: Context = {
    systemPrompt: ["Use read and bash; keep read_file as literal text."],
    tools: originals.map((name) => ({
      name,
      description: "read bash write are unchanged description text",
      parameters: { type: "object" as const, properties: { read: { type: "string" as const } } },
    })),
    messages: [
      { role: "user", content: "read write_file", timestamp: 0 },
      assistant(originals.map((name, index) => ({
        type: "toolCall" as const,
        id: `call/${index}`,
        name,
        arguments: args,
        thoughtSignature: "Y2FsbA==",
      }))),
      ...originals.map((name, index) => ({
        role: "toolResult" as const,
        toolCallId: `call/${index}`,
        toolName: `not-the-call-name-${name}`,
        content: [{ type: "text" as const, text: "read bash read_file" }],
        isError: false,
        timestamp: 0,
      })),
    ],
  };
  const before = structuredClone(context);
  const { body, result } = await capture(context, { toolChoice: { type: "function", function: { name: "read" } } });
  expect(result.stopReason).toBe("stop");
  expect(body).toMatchObject({
    request: {
      systemInstruction: { role: "user", parts: [{ text: context.systemPrompt?.join("\n\n") }] },
      tools: native.map((name) => ({
        functionDeclarations: [{
          name,
          description: "read bash write are unchanged description text",
          parameters: { type: "OBJECT", properties: { read: { type: "STRING" } } },
        }],
      })),
      contents: [
        { role: "user", parts: [{ text: "read write_file" }] },
        { role: "model", parts: native.map((name, index) => ({
          functionCall: { id: `call/${index}`, name, args },
          thoughtSignature: "Y2FsbA==",
        })) },
        { role: "model", parts: native.map((name, index) => ({
          functionResponse: { id: `call/${index}`, name, response: { output: "read bash read_file" } },
        })) },
      ],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] } },
    },
  });
  expect(context).toEqual(before);
});

test.each([
  { original: "read", native: "read_file" },
  { original: "bash", native: "run_command" },
  { original: "write", native: "write_file" },
  { original: "edit", native: "edit_file" },
  { original: "task", native: "invoke_subagent" },
  { original: "web_search", native: "search_web" },
  { original: "ask", native: "ask_question" },
  { original: "apply_patch", native: "edit_file" },
])("restores $native to $original in every partial, toolcall end and final result", async ({ original, native }) => {
  const args = { path: "read_file", nested: { name: native }, lines: [1, 2] };
  const call = { type: "toolCall" as const, id: "native/call-id", name: original, arguments: args, thoughtSignature: "Y2FsbA==" };
  const context: Context = {
    messages: [{ role: "user", content: "Inspect", timestamp: 0 }],
    tools: [{ name: original, description: "", parameters: { type: "object" } }],
  };
  const before = structuredClone(context);
  const { body, events, result } = await capture(context, undefined, {}, "gemini-3.8-flash", sse([
    { functionCall: { id: call.id, name: native, args }, thoughtSignature: call.thoughtSignature },
    { text: "read_file remains literal text" },
  ]));
  expect(body).toMatchObject({ request: { tools: [{ functionDeclarations: [{ name: native }] }] } });
  expect(result.stopReason).toBe("toolUse");
  expect(result.content).toEqual([call, { type: "text", text: "read_file remains literal text" }]);
  expect(events.map((event) => event.type)).toContain("toolcall_start");
  expect(events.map((event) => event.type)).toContain("toolcall_delta");
  expect(events.map((event) => event.type)).toContain("toolcall_end");
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: result.content } });
  for (const event of events) {
    const message = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
    for (const block of message.content) {
      if (block.type === "toolCall") expect(block).toEqual(call);
    }
    if (event.type === "toolcall_delta") expect(event.delta).toBe(JSON.stringify(args));
    if (event.type === "toolcall_end") expect(event.toolCall).toEqual(call);
  }
  expect(context).toEqual(before);

  if (original === "read") {
    const replay: Context = {
      ...context,
      messages: [
        ...context.messages,
        result,
        { role: "toolResult", toolCallId: call.id, toolName: original, content: [{ type: "text", text: "read_file output" }], isError: false, timestamp: 0 },
      ],
    };
    const replayBefore = structuredClone(replay);
    const second = await capture(replay);
    expect(second.result.stopReason).toBe("stop");
    expect(second.body).toMatchObject({ request: { contents: [
      { role: "user", parts: [{ text: "Inspect" }] },
      { role: "model", parts: [
        { text: "read_file remains literal text" },
        { functionCall: { id: call.id, name: native, args }, thoughtSignature: call.thoughtSignature },
      ] },
      { role: "model", parts: [{ functionResponse: { id: call.id, name: native, response: { output: "read_file output" } } }] },
    ] } });
    expect(replay).toEqual(replayBefore);
  }
});

test.each([
  { choice: { type: "function" as const, name: "read" }, original: "read", native: "read_file" },
  { choice: { type: "function" as const, function: { name: "web_search" } }, original: "web_search", native: "search_web" },
  { choice: { type: "tool" as const, name: "ask" }, original: "ask", native: "ask_question" },
])("derives a reversible mapping from an explicit choice alone: $original", async ({ choice, original, native }) => {
  const { body, result } = await capture(
    { messages: [{ role: "user", content: "Inspect", timestamp: 0 }] },
    { toolChoice: choice },
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: "choice/call", name: native, args: {} } }]),
  );
  expect(body).not.toHaveProperty("request.tools");
  expect(body).toMatchObject({ request: { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [native] } } } });
  expect(result.content).toEqual([{ type: "toolCall", id: "choice/call", name: original, arguments: {} }]);
});

test("derives a reversible mapping from historical calls without declarations", async () => {
  const { body, result } = await capture(
    {
      messages: [
        assistant([{ type: "toolCall", id: "old/read", name: "read", arguments: { path: "before" } }]),
        { role: "toolResult", toolCallId: "old/read", toolName: "stale-name", content: [{ type: "text", text: "before" }], isError: false, timestamp: 0 },
      ],
    },
    undefined,
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: "new/read", name: "read_file", args: { path: "after" } } }]),
  );
  expect(body).not.toHaveProperty("request.tools");
  expect(body).toMatchObject({ request: { contents: [
    { role: "model", parts: [{ functionCall: { id: "old/read", name: "read_file", args: { path: "before" } } }] },
    { role: "model", parts: [{ functionResponse: { id: "old/read", name: "read_file", response: { output: "before" } } }] },
  ] } });
  expect(result.content).toEqual([{ type: "toolCall", id: "new/read", name: "read", arguments: { path: "after" } }]);
});

test("keeps native aliases, custom and MCP tools distinct in both directions", async () => {
  const originals = ["read", "read_file", "bash", "run_command", "edit", "edit_file", "apply_patch", "inspect", "mcp__server__read"];
  const { body, events, result } = await capture(
    {
      tools: originals.map((name) => ({ name, description: "", parameters: { type: "object" as const } })),
      messages: [assistant(originals.map((name, index) => ({ type: "toolCall" as const, id: `old/${index}`, name, arguments: {} })))],
    },
    { toolChoice: { type: "function", name: "read" } },
    {},
    "gemini-3.8-flash",
    sse(originals.map((name, index) => ({ functionCall: { id: `new/${index}`, name, args: { name } } }))),
  );
  expect(body).toMatchObject({ request: {
    tools: originals.map((name) => ({ functionDeclarations: [{ name }] })),
    contents: [{ role: "model", parts: originals.map((name, index) => ({ functionCall: { id: `old/${index}`, name, args: {} } })) }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read"] } },
  } });
  expect(result.content).toEqual(originals.map((name, index) => ({ type: "toolCall" as const, id: `new/${index}`, name, arguments: { name } })));
  for (const event of events) {
    if (event.type === "toolcall_end") expect(originals[event.contentIndex]).toBe(event.toolCall.name);
  }
});

test.each(["history", "choice"] as const)("reserves alias identities present only in %s", async (source) => {
  const { body, result } = await capture(
    {
      tools: [{ name: "read", description: "", parameters: { type: "object" } }],
      messages: source === "history"
        ? [assistant([{ type: "toolCall", id: "old/native", name: "read_file", arguments: {} }])]
        : [{ role: "user", content: "Inspect", timestamp: 0 }],
    },
    source === "choice" ? { toolChoice: { type: "function", name: "read_file" } } : undefined,
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: "new/native", name: "read_file", args: {} } }]),
  );
  expect(body).toMatchObject({ request: { tools: [{ functionDeclarations: [{ name: "read" }] }] } });
  expect(result.content).toEqual([{ type: "toolCall", id: "new/native", name: "read_file", arguments: {} }]);
});

test("does not alias apply_patch when edit appears only in history", async () => {
  const { body, result } = await capture(
    {
      tools: [{ name: "apply_patch", description: "", parameters: { type: "object" } }],
      messages: [assistant([{ type: "toolCall", id: "old/edit", name: "edit", arguments: {} }])],
    },
    { toolChoice: { type: "function", name: "apply_patch" } },
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: "new/patch", name: "apply_patch", args: {} } }]),
  );
  expect(body).toMatchObject({ request: {
    tools: [{ functionDeclarations: [{ name: "apply_patch" }] }],
    contents: [{ role: "model", parts: [{ functionCall: { id: "old/edit", name: "edit_file", args: {} } }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["apply_patch"] } },
  } });
  expect(result.content).toEqual([{ type: "toolCall", id: "new/patch", name: "apply_patch", arguments: {} }]);
});

test("restores tool names in error events and error results", async () => {
  const call = { type: "toolCall" as const, id: "failed/call", name: "read", arguments: { path: "read_file" }, thoughtSignature: "Y2FsbA==" };
  const { events, result } = await capture(
    { tools: [{ name: "read", description: "", parameters: { type: "object" } }], messages: [{ role: "user", content: "Inspect", timestamp: 0 }] },
    undefined,
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: call.id, name: "read_file", args: call.arguments }, thoughtSignature: call.thoughtSignature }], "SAFETY"),
  );
  expect(result.stopReason).toBe("error");
  expect(result.content).toEqual([call]);
  expect(events.at(-1)).toMatchObject({ type: "error", error: { content: [call] } });
  for (const event of events) {
    if ("partial" in event) {
      for (const block of event.partial.content) {
        if (block.type === "toolCall") expect(block).toEqual(call);
      }
    }
    if (event.type === "toolcall_end") expect(event.toolCall).toEqual(call);
  }
});

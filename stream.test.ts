import { expect, test } from "bun:test";
import {
  streamSimple,
  validateToolArguments,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type SimpleStreamOptions,
  type Tool,
} from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("keeps declarations, history, paired results and choice consistent across aliases", async () => {
  const originals = [
    "read", "bash", "write", "edit", "task", "web_search", "ask", "apply_patch", "inspect", "mcp__server__read",
  ];
  const native = [
    "read_file", "run_command", "write_file", "edit_file", "invoke_subagent", "search_web", "ask_question", "apply_patch", "inspect", "mcp__server__read",
  ];
  const historical = [
    "read", "run_command", "write", "edit_file", "invoke_subagent", "search_web", "ask_question", "apply_patch", "inspect", "mcp__server__read",
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
      tools: originals.flatMap((name, index) => {
        const host = {
          name: historical[index],
          description: "read bash write are unchanged description text",
          parameters: { type: "OBJECT", properties: { read: { type: "STRING" } } },
        };
        if (name !== "read" && name !== "write") return [{ functionDeclarations: [host] }];
        return [
          {
            functionDeclarations: [{
              name: native[index],
              description: expect.any(String),
              parameters: { ...host.parameters, properties: expect.any(Object) },
            }],
          },
          { functionDeclarations: [host] },
        ];
      }),
      contents: [
        { role: "user", parts: [{ text: "read write_file" }] },
        { role: "model", parts: historical.map((name, index) => ({
          functionCall: { id: `call/${index}`, name, args },
          thoughtSignature: "Y2FsbA==",
        })) },
        { role: "model", parts: historical.map((name, index) => ({
          functionResponse: { id: `call/${index}`, name, response: { output: "read bash read_file" } },
        })) },
      ],
      toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file", "read"] } },
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
  const others = { path: "read_file", nested: { name: native }, lines: [1, 2] };
  const nativeArgs =
    original === "read"
      ? { Path: "notes.txt" }
      : original === "write"
        ? { Path: "notes.txt", Content: "text", Overwrite: true }
        : others;
  const args =
    original === "read"
      ? { path: "notes.txt:raw" }
      : original === "write"
        ? { path: "notes.txt", content: "text" }
        : others;
  const call = {
    type: "toolCall" as const,
    id: "native/call-id",
    name: original,
    arguments: args,
    thoughtSignature: "Y2FsbA==",
    ...(original === "read" ? { antigravityReadPath: "notes.txt:raw" } : {}),
  };
  const context: Context = {
    messages: [{ role: "user", content: "Inspect", timestamp: 0 }],
    tools: [{ name: original, description: "Host tool", parameters: { type: "object" } }],
  };
  const before = structuredClone(context);
  const { body, events, result } = await capture(context, undefined, {}, "gemini-3.8-flash", sse([
    { functionCall: { id: call.id, name: native, args: nativeArgs }, thoughtSignature: call.thoughtSignature },
    { text: "read_file remains literal text" },
  ]));
  const declaredNames = original === "read" || original === "write" ? [native, original] : [native];
  expect(body).toMatchObject({
    request: { tools: declaredNames.map((name) => ({ functionDeclarations: [{ name }] })) },
  });
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
        { functionCall: { id: call.id, name: native, args: nativeArgs }, thoughtSignature: call.thoughtSignature },
      ] },
      { role: "model", parts: [{ functionResponse: { id: call.id, name: native, response: { output: "read_file output" } } }] },
    ] } });
    expect(replay).toEqual(replayBefore);
  }
});

test.each([
  { choice: { type: "function" as const, name: "read" }, original: "read", native: "read" },
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

test("keeps host read history and does not activate an undeclared native route", async () => {
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
    sse([{ functionCall: { id: "new/read", name: "read_file", args: { Path: "after" } } }]),
  );
  expect(body).not.toHaveProperty("request.tools");
  expect(body).toMatchObject({ request: { contents: [
    { role: "model", parts: [{ functionCall: { id: "old/read", name: "read", args: { path: "before" } } }] },
    { role: "model", parts: [{ functionResponse: { id: "old/read", name: "read", response: { output: "before" } } }] },
  ] } });
  expect(result.content).toEqual([{ type: "toolCall", id: "new/read", name: "read_file", arguments: { Path: "after" } }]);
});

test.each([
  { extra: "encoding", properties: { encoding: { type: "string" } }, expected: ["path", "encoding"] },
  { extra: "i", properties: {}, expected: ["path"] },
])("does not advertise a native route that cannot supply required $extra", async ({ extra, properties, expected }) => {
  const { body } = await capture({
    tools: [{
      name: "read",
      description: "Host read with extra requirements",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, ...properties },
        required: ["path", extra],
      },
    }],
    messages: [],
  });
  expect(body).toMatchObject({
    request: {
      tools: [{
        functionDeclarations: [{
          name: "read",
          parameters: { required: expected },
        }],
      }],
    },
  });
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
  const call = {
    type: "toolCall" as const,
    id: "failed/call",
    name: "read",
    arguments: { path: "read_file:raw" },
    thoughtSignature: "Y2FsbA==",
    antigravityReadPath: "read_file:raw",
  };
  const { events, result } = await capture(
    { tools: [{ name: "read", description: "", parameters: { type: "object" } }], messages: [{ role: "user", content: "Inspect", timestamp: 0 }] },
    undefined,
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: call.id, name: "read_file", args: { Path: "read_file" } }, thoughtSignature: call.thoughtSignature }], "SAFETY"),
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

test("declares and round-trips native read ranges with OMP intent metadata", async () => {
  const intent = "Reading selected lines";
  const nativeArgs = { Path: "notes.txt", StartLine: 2, EndLine: 3, i: intent };
  const context: Context = {
    tools: [{
      name: "read",
      description: "Host read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, i: { type: "string", description: "Concise intent" } },
        required: ["path", "i"],
      },
    }],
    messages: [{ role: "user", content: "Read", timestamp: 0 }],
  };
  const { body, events, result } = await capture(
    context,
    undefined,
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: "native/read", name: "read_file", args: nativeArgs } }]),
  );
  expect(body).toMatchObject({
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "read_file",
              parameters: {
                type: "OBJECT",
                properties: {
                  Path: { type: "STRING", pattern: "^[\\p{L}\\p{M}\\p{N}_. /-]+$" },
                  StartLine: { type: "INTEGER", minimum: 1, maximum: 9007199254740991 },
                  EndLine: { type: "INTEGER", minimum: 1, maximum: 9007199254740991 },
                  i: { type: "STRING", description: "Concise intent" },
                },
                required: ["Path", "i"],
              },
            },
          ],
        },
        { functionDeclarations: [{ name: "read", parameters: { required: ["path", "i"] } }] },
      ],
    },
  });
  const call = {
    type: "toolCall" as const,
    id: "native/read",
    name: "read",
    arguments: { path: "notes.txt:raw:2-3", i: intent },
    antigravityReadPath: "notes.txt:raw:2-3",
  };
  expect(result.stopReason).toBe("toolUse");
  expect(result.content).toEqual([call]);
  expect(events.find((event) => event.type === "toolcall_delta")).toMatchObject({
    delta: JSON.stringify(call.arguments),
  });
  expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({ toolCall: call });

  const replay: Context = {
    ...context,
    messages: [
      ...context.messages,
      result,
      {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "read",
        content: [{ type: "text", text: "inside" }],
        isError: false,
        timestamp: 0,
      },
    ],
  };
  const second = await capture(replay);
  expect(second.result.stopReason).toBe("stop");
  expect(second.body).toMatchObject({
    request: {
      contents: [
        { role: "user", parts: [{ text: "Read" }] },
        { role: "model", parts: [{ functionCall: { id: call.id, name: "read_file", args: nativeArgs } }] },
        {
          role: "model",
          parts: [{ functionResponse: { id: call.id, name: "read_file", response: { output: "inside" } } }],
        },
      ],
    },
  });
});

const writeTool = {
  name: "write",
  description: "Write a local file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
} satisfies Tool;

test.each(["Executes mounted devices with xd://<tool> and writes local:// scratch.", ""])(
  "keeps the OMP write route when no local write capability is advertised (%s)",
  async (description) => {
    const args = { path: "xd://fixture", content: "{}" };
    const { body, result } = await capture(
      { tools: [{ ...writeTool, description }], messages: [] },
      { toolChoice: { type: "function", name: "write" } },
      {},
      "gemini-3.8-flash",
      sse([{ functionCall: { id: "device", name: "write", args } }]),
    );
    expect(body).toMatchObject({
      request: {
        tools: [{ functionDeclarations: [{ name: "write", parameters: { required: ["path", "content"] } }] }],
        toolConfig: { functionCallingConfig: { allowedFunctionNames: ["write"] } },
      },
    });
    expect(result.content).toEqual([{ type: "toolCall", id: "device", name: "write", arguments: args }]);
  },
);

test("rejects invalid native writes before host execution without losing valid sibling calls", async () => {
  const { result } = await capture(
    { tools: [writeTool], messages: [] },
    undefined,
    {},
    "gemini-3.8-flash",
    sse([
      { functionCall: { id: "invalid", name: "write_file", args: { Path: "invalid.txt", Content: "", Overwrite: false } } },
      { functionCall: { id: "valid", name: "write_file", args: { Path: "valid.txt", Content: "", Overwrite: true } } },
    ]),
  );
  expect(result.stopReason).toBe("toolUse");
  const [invalid, valid] = result.content;
  if (invalid?.type !== "toolCall" || valid?.type !== "toolCall") throw new Error("Expected both calls");
  expect(invalid).toMatchObject({ id: "invalid", name: "write" });
  expect(() => validateToolArguments(writeTool, invalid)).toThrow("Invalid write_file arguments");
  expect(validateToolArguments(writeTool, valid)).toEqual({ path: "valid.txt", content: "" });
});

test("passes a non-directory read path to OMP without failing the stream", async () => {
  const { result } = await capture(
    {
      tools: [{ name: "read", description: "Host read", parameters: { type: "object" } }],
      messages: [],
    },
    { cwd: import.meta.dir },
    {},
    "gemini-3.8-flash",
    sse([{ functionCall: { id: "not-dir", name: "read_file", args: { Path: "package.json/file" } } }]),
  );
  expect(result.stopReason).toBe("toolUse");
  const call = {
    type: "toolCall" as const,
    id: "not-dir",
    name: "read",
    arguments: { path: "package.json/file:raw" },
    antigravityReadPath: "package.json/file:raw",
  };
  expect(result.content).toEqual([call]);
});

const searchTools = [
  { name: "grep", description: "Host grep", parameters: { type: "object" } },
  { name: "glob", description: "Host glob", parameters: { type: "object" } },
] satisfies Tool[];

test.each(["workspace", "workspace (fixture)"])(
  "checks canonical search targets without disabling native search in %s",
  async (workspace) => {
    const dir = await mkdtemp(join(tmpdir(), "agy-search-"));
    try {
      const cwd = join(dir, workspace);
      const inside = join(cwd, "inside");
      const outside = join(dir, "outside");
      await Promise.all([mkdir(inside, { recursive: true }), mkdir(outside)]);
      await Promise.all([
        symlink(inside, join(cwd, "internal")),
        symlink(outside, join(cwd, "external")),
      ]);
      const canonicalInside = await realpath(inside);
      const needsRelativePath = workspace.includes("(");
      const grepArgs = { Query: "a.b", MatchPerLine: true, IsRegex: false };
      const { body, result } = await capture(
        { tools: searchTools, messages: [] },
        { cwd },
        {},
        "gemini-3.8-flash",
        sse([
          { functionCall: { id: "grep/inside", name: "grep_search", args: { SearchPath: "internal", ...grepArgs } } },
          { functionCall: { id: "grep/outside", name: "grep_search", args: { SearchPath: "external", ...grepArgs } } },
          { functionCall: { id: "glob/outside", name: "find_by_name", args: { SearchDirectory: "external", Pattern: "*.txt" } } },
          {
            functionCall: {
              id: "glob/inside",
              name: "find_by_name",
              args: { SearchDirectory: needsRelativePath ? "." : canonicalInside, Pattern: "*.txt" },
            },
          },
        ]),
      );
      expect(body).toMatchObject({
        request: {
          tools: [
            { functionDeclarations: [{ name: "grep_search", parameters: { properties: { SearchPath: { type: "STRING" } } } }] },
            { functionDeclarations: [{ name: "grep" }] },
            { functionDeclarations: [{ name: "find_by_name", parameters: { properties: { SearchDirectory: { type: "STRING" } } } }] },
            { functionDeclarations: [{ name: "glob" }] },
          ],
        },
      });
      expect(result.stopReason).toBe("toolUse");
      const [valid, rejectedGrep, rejectedGlob, validGlob] = result.content;
      expect(valid).toEqual({
        type: "toolCall",
        id: "grep/inside",
        name: "grep",
        arguments: { path: needsRelativePath ? "inside" : canonicalInside, pattern: "a\\.b" },
      });
      for (const [call, tool] of [[rejectedGrep, searchTools[0]], [rejectedGlob, searchTools[1]]] as const) {
        if (call?.type !== "toolCall" || !tool) throw new Error("Expected rejected search call");
        expect(() => validateToolArguments(tool, call)).toThrow("inside the workspace");
      }
      expect(validGlob).toEqual({
        type: "toolCall",
        id: "glob/inside",
        name: "glob",
        arguments: {
          path: join(needsRelativePath ? "." : canonicalInside, "**", "*.[tT][xX][tT]"),
          limit: 50,
          gitignore: true,
          hidden: false,
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("replays only equivalent native searches and pairs both routes with their original results", async () => {
  const outside = join(import.meta.dir, "..");
  const outsideGrep = { path: outside, pattern: "word", case: true };
  const outsideGlob = { path: join(outside, "**", "Readme.md"), limit: 50, gitignore: true, hidden: false };
  const cases = [
    {
      host: "grep", args: { path: ".", pattern: "word.*", case: true },
      wire: "grep", wireArgs: { path: ".", pattern: "word.*", case: true },
    },
    {
      host: "grep", args: { path: ".", pattern: "word\\.\\*", case: true },
      wire: "grep_search",
      wireArgs: { SearchPath: ".", Query: "word.*", MatchPerLine: true, IsRegex: false, CaseInsensitive: false },
    },
    {
      host: "glob", args: { path: "./**/[aB].txt", limit: 50, gitignore: true, hidden: false },
      wire: "glob", wireArgs: { path: "./**/[aB].txt", limit: 50, gitignore: true, hidden: false },
    },
    {
      host: "glob", args: { path: "./**/Readme.md", limit: 50, gitignore: true, hidden: false },
      wire: "find_by_name", wireArgs: { SearchDirectory: ".", Pattern: "Readme.md" },
    },
    {
      host: "glob", args: { path: "./**/docs/**/*.txt", limit: 50, gitignore: true, hidden: false },
      wire: "glob", wireArgs: { path: "./**/docs/**/*.txt", limit: 50, gitignore: true, hidden: false },
    },
    { host: "grep", args: outsideGrep, wire: "grep", wireArgs: outsideGrep },
    { host: "glob", args: outsideGlob, wire: "glob", wireArgs: outsideGlob },
  ];
  const { body, result } = await capture({
    tools: searchTools,
    messages: [
      assistant(cases.map(({ host, args }, i) => ({
        type: "toolCall", id: `search/${i}`, name: host, arguments: args,
      }))),
      ...cases.map(({ host }, i) => ({
        role: "toolResult" as const,
        toolCallId: `search/${i}`,
        toolName: host,
        content: [{ type: "text" as const, text: `result/${i}` }],
        isError: false,
        timestamp: 0,
      })),
    ],
  }, { cwd: import.meta.dir });
  expect(result.stopReason).toBe("stop");
  expect(body).toHaveProperty("request.contents", [
    {
      role: "model",
      parts: cases.map(({ wire, wireArgs }, i) => ({
        functionCall: { id: `search/${i}`, name: wire, args: wireArgs },
      })),
    },
    {
      role: "model",
      parts: cases.map(({ wire }, i) => ({
        functionResponse: { id: `search/${i}`, name: wire, response: { output: `result/${i}` } },
      })),
    },
  ]);
});

test.each([true, false])("keeps literal read history regardless of whether the file still exists (%s)", async (exists) => {
  const cwd = await mkdtemp(join(tmpdir(), "agy-read-"));
  try {
    const path = "notes.txt:raw";
    const text = "literal filename";
    await Bun.write(join(cwd, path), text);
    if (!exists) await rm(join(cwd, path));
    const { body } = await capture(
      {
        tools: [{ name: "read", description: "Host read", parameters: { type: "object" } }],
        messages: [
          assistant([{ type: "toolCall", id: "literal", name: "read", arguments: { path } }]),
          {
            role: "toolResult", toolCallId: "literal", toolName: "read",
            content: [{ type: "text", text }], isError: false, timestamp: 0,
          },
        ],
      },
      { cwd },
    );
    expect(body).toHaveProperty("request.contents", [
      { role: "model", parts: [{ functionCall: { id: "literal", name: "read", args: { path } } }] },
      {
        role: "model",
        parts: [{ functionResponse: { id: "literal", name: "read", response: { output: text } } }],
      },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

import { afterEach, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth";
import antigravityExtension from "./index";
import { nativeAgentRequest, type ProtocolContext } from "./protocol";
import { envelope, nativeWireRequest } from "./wire";
import { rememberNativeModels } from "./native-models";
import { streamAntigravity } from "./stream";

const originalVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
const originalCL = process.env.PI_AI_ANTIGRAVITY_CL;

afterEach(() => {
  unregisterOAuthProvider("google-antigravity");
  if (originalVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
  else process.env.PI_AI_ANTIGRAVITY_VERSION = originalVersion;
  if (originalCL === undefined) delete process.env.PI_AI_ANTIGRAVITY_CL;
  else process.env.PI_AI_ANTIGRAVITY_CL = originalCL;
});

test.each([
  { level: "HIGH", wireLevel: "HIGH", toolMode: "ANY", schemaType: "OBJECT" },
  { level: "EXTRA_HIGH", wireLevel: 5, toolMode: 2, schemaType: 6 },
  { level: "MAX", wireLevel: 6, toolMode: 2, schemaType: 6 },
  { level: "XHIGH", wireLevel: "XHIGH", toolMode: "ANY", schemaType: "OBJECT" },
])(
  "matches native global enum serialization for $level without rewriting function data",
  ({ level, wireLevel, toolMode, schemaType }) => {
    const model = buildModel({
      provider: "google-antigravity",
      api: "google-gemini-cli",
      id: "gemini-3.8-flash",
      name: "Flash",
      reasoning: true,
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const contents = [
      {
        role: "model",
        parts: [
          { functionCall: { name: "run", args: { type: "object", mode: "ANY", level: "MAX" } } },
        ],
      },
    ];
    const payload = {
      project: "project",
      model: "gemini-3.8-flash",
      requestId: "agent/random-id/123456789/trajectory-id/3",
      userAgent: "antigravity",
      userPromptId: "must-be-cleared",
      enabledCreditTypes: ["GOOGLE_ONE_AI"],
      request: {
        contents,
        sessionId: "-99",
        generationConfig: {
          temperature: 0.7,
          topP: 0.8,
          maxOutputTokens: 65536,
          responseModalities: ["AUDIO", "VIDEO"],
          thinkingConfig: { includeThoughts: true, thinkingLevel: level },
        },
        labels: {
          cascade_id: "random-id",
          root_cascade_id: "random-id",
          trajectory_id: "trajectory-id",
          request_id: "trajectory-id-1",
          last_step_index: "2",
          used_claude: "false",
          used_claude_conservative: "false",
          used_non_gemini_model: "false",
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: "run",
                parameters: {
                  type: "object",
                  properties: {
                    items: {
                      type: "array",
                      items: { type: "string", enum: ["HIGH", "MAX"] },
                    },
                  },
                },
              },
              { name: "read", parameters: { type: "object" } },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "ANY" } },
      },
    };

    const wire = nativeWireRequest(
      envelope.parse(
        nativeAgentRequest(payload, {
          model,
          sessionManager: {
            getSessionId: () => "cascade-id",
            getBranch: () => [
              {
                type: "message",
                message: {
                  role: "assistant",
                  provider: "google-antigravity",
                  model: "claude-sonnet-5-5",
                },
              },
            ],
          },
        }),
      ),
    );

    expect(wire).toMatchObject({
      requestType: "agent",
      requestId: "agent/cascade-id/123456789/trajectory-id/3",
      request: {
        sessionId: "-3750763034362895579",
        labels: {
          cascade_id: "cascade-id",
          root_cascade_id: "cascade-id",
          trajectory_id: "trajectory-id",
          request_id: "trajectory-id-1",
          last_step_index: "2",
          used_claude: "true",
          used_claude_conservative: "true",
          used_non_gemini_model: "true",
        },
        generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingLevel: wireLevel } },
        toolConfig: { functionCallingConfig: { mode: toolMode } },
      },
    });
    expect(wire).not.toHaveProperty("userPromptId");
    expect(wire).not.toHaveProperty("enabledCreditTypes");
    expect(wire.request.generationConfig?.responseModalities).toEqual(
      typeof wireLevel === "number" ? [3, 4] : ["AUDIO", "VIDEO"],
    );
    expect(wire.request.generationConfig).not.toHaveProperty("temperature");
    expect(wire.request.generationConfig).not.toHaveProperty("topP");
    expect(wire.request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "run",
            parameters: {
              type: schemaType,
              properties: {
                items: {
                  type: typeof schemaType === "number" ? 5 : "ARRAY",
                  items: {
                    type: typeof schemaType === "number" ? 1 : "STRING",
                    enum: ["HIGH", "MAX"],
                  },
                },
              },
            },
          },
        ],
      },
      { functionDeclarations: [{ name: "read", parameters: { type: schemaType } }] },
    ]);
    expect(wire.request.contents).toEqual(contents);
  },
);

test("leaves requests without an Antigravity chat model unchanged", () => {
  const payload = { project: "p", request: { contents: [] } };
  expect(
    nativeAgentRequest(payload, {
      model: undefined,
      sessionManager: { getSessionId: () => "unused", getBranch: () => [] },
    }),
  ).toBe(payload);
});

test("sends the audited native identity and agent envelope on an actual HTTP request", async () => {
  // Captured from the official agy 1.5.6 binary, including its embedded CL.
  process.env.PI_AI_ANTIGRAVITY_VERSION = "2.26.0";
  process.env.PI_AI_ANTIGRAVITY_CL = "1005016104";
  let payloadHook: unknown;
  let shutdown: unknown;
  antigravityExtension({
    async setModel() {
      return true;
    },
    on(event, handler) {
      if (event === "before_provider_request") payloadHook = handler;
      if (event === "session_shutdown") shutdown = handler;
    },
    registerProvider(id, config) {
      registerOAuthProvider({ id, ...config.oauth });
    },
  });
  let headers = new Headers();
  let body: unknown;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      headers = request.headers;
      body = await request.json();
      return new Response(
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  try {
    const model = buildModel({
      provider: "google-antigravity",
      api: "google-gemini-cli",
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      baseUrl: server.url.origin,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65536,
    });
    const context: ProtocolContext = {
      model,
      sessionManager: { getSessionId: () => "http-session", getBranch: () => [] },
    };
    rememberNativeModels("Bearer local-test-token", {
      models: {
        "gemini-3.8-flash": { model: "MODEL_PLACEHOLDER_M320", maxOutputTokens: 65536 },
      },
    });
    const stream = streamAntigravity(
      model,
      { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] },
      {
        apiKey: JSON.stringify({ token: "local-test-token", projectId: "test-project" }),
        onPayload: (payload) => {
          if (typeof payloadHook !== "function") throw new Error("Missing provider request hook");
          return payloadHook({ payload }, context);
        },
      },
    );
    for await (const event of stream) {
      if (event.type === "error") throw new Error(event.error.errorMessage);
    }
    expect(headers.get("user-agent")).toBe(
      "antigravity/cli/1.5.6 (aidev_client; os_type=darwin; arch=arm64; cl=1018951551; auth_method=consumer)",
    );
    expect(headers.has("accept")).toBe(false);
    expect(headers.has("anthropic-beta")).toBe(false);
    expect(body).toMatchObject({
      requestType: "agent",
      request: {
        sessionId: "-3750763034362895579",
        labels: { cascade_id: "http-session" },
        generationConfig: { maxOutputTokens: 65536, thinkingConfig: { thinkingBudget: 0 } },
      },
    });
  } finally {
    if (typeof shutdown === "function") shutdown();
    await server.stop(true);
  }
});

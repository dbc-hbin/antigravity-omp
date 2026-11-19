import { expect, test } from "bun:test";
import { streamSimple, type ToolChoice } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { loadExtension } from "./extension-fixture";
import { envelope } from "./wire";
import { API_ID } from "./stream";

const cases: { id: string; choice?: ToolChoice; mode?: string; names?: string[] }[] = [
  { id: "gemini-3.8-flash" },
  { id: "gemini-3.8-flash", choice: "auto", mode: "VALIDATED" },
  { id: "claude-sonnet-5-5", choice: "auto", mode: "VALIDATED" },
  { id: "claude-sonnet-5-5", choice: "none", mode: "NONE" },
  { id: "claude-sonnet-5-5", choice: "required", mode: "ANY" },
  {
    id: "claude-sonnet-5-5",
    choice: { type: "function", name: "read" },
    mode: "ANY",
    names: ["read_file", "read"],
  },
  { id: "claude-sonnet-4-6", choice: "auto", mode: "VALIDATED" },
];

test.each(cases)(
  "sends native $id tool choice $choice to the HTTP receiver",
  async ({ id, choice, mode, names }) => {
    process.env.PI_AI_ANTIGRAVITY_VERSION = "2.26.0";
    process.env.PI_AI_ANTIGRAVITY_CL = "1005016104";
    const { modifyModels, payloadHook, models } = await loadExtension();
    let headers = new Headers();
    let body: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/v1internal:fetchAvailableModels") {
          return Response.json({
            models: {
              "gemini-3.8-flash-high": {
                model: "MODEL_PLACEHOLDER_M318",
                apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
                supportsThinking: true,
                maxOutputTokens: 65536,
                thinkingBudget: -1,
              },
              "claude-sonnet-5-5-high": {
                model: "MODEL_PLACEHOLDER_M405",
                apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
                supportsThinking: true,
                maxOutputTokens: 128000,
                thinkingLevel: 3,
              },
              "claude-sonnet-4-6": {
                model: "MODEL_PLACEHOLDER_M35",
                apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX",
                supportsThinking: true,
                maxOutputTokens: 64000,
                thinkingBudget: 1024,
              },
            },
          });
        }
        headers = request.headers;
        body = await request.json();
        return new Response(
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    try {
      const discovery = await fetch(new URL("/v1internal:fetchAvailableModels", server.url), {
        method: "POST",
        headers: {
          "User-Agent": "antigravity/hub/1.5.9",
          Authorization: "Bearer local-test-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: "test-project" }),
      });
      expect(discovery.status).toBe(200);
      const source = models.find((model) => model.id === id);
      if (!source) throw new Error(`Missing model ${id}`);
      const projected = modifyModels([source])[0];
      if (!projected) throw new Error("Model was removed");
      const model = buildModel({ ...toModelSpec(projected), baseUrl: server.url.origin });
      const reasoning = THINKING_EFFORTS.find((effort) => effort === "high");
      if (!reasoning) throw new Error("Missing high thinking effort");
      const stream = streamSimple(
        model,
        {
          messages: [{ role: "user", content: "Reply OK", timestamp: 0 }],
          tools: [
            {
              name: "inspect",
              description: "Inspect a path",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
            {
              name: "read",
              description: "Read a path",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        },
        {
          apiKey: JSON.stringify({ token: "local-test-token", projectId: "test-project" }),
          reasoning,
          ...(choice ? { toolChoice: choice } : {}),
          onPayload: (payload) => {
            if (typeof payloadHook !== "function") throw new Error("Missing payload hook");
            return payloadHook(
              { payload },
              {
                model,
                sessionManager: { getSessionId: () => "http-session", getBranch: () => [] },
              },
            );
          },
        },
      );
      for await (const event of stream) {
        if (event.type === "error") throw new Error(event.error.errorMessage);
      }
      expect((await stream.result()).content).toContainEqual({ type: "text", text: "OK" });
      expect(headers.get("user-agent")).toBe(
        "antigravity/cli/1.5.9 (aidev_client; os_type=darwin; arch=arm64; cl=1021519450; auth_method=consumer)",
      );
      expect(headers.has("accept")).toBe(false);
      expect(headers.has("anthropic-beta")).toBe(false);
      expect(headers.get("authorization")).toBe("Bearer local-test-token");
      const wire = envelope.parse(body);
      expect(wire).toMatchObject({
        requestType: "agent",
        model:
          id === "claude-sonnet-4-6"
            ? id
            : id === "gemini-3.8-flash"
              ? "gemini-3.8-flash-high"
              : "claude-sonnet-5-5-high",
        request: {
          sessionId: "-3750763034362895579",
          labels: {
            cascade_id: "http-session",
            root_cascade_id: "http-session",
            model_enum:
              id === "claude-sonnet-4-6"
                ? "MODEL_PLACEHOLDER_M35"
                : id === "gemini-3.8-flash"
                  ? "MODEL_PLACEHOLDER_M318"
                  : "MODEL_PLACEHOLDER_M405",
          },
          generationConfig:
            id === "claude-sonnet-4-6"
              ? {
                  maxOutputTokens: 64000,
                  thinkingConfig: { includeThoughts: true, thinkingBudget: 1024 },
                }
              : {
                  maxOutputTokens: id === "gemini-3.8-flash" ? 65536 : 128000,
                  thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
                },
        },
      });
      expect(wire.request.toolConfig?.functionCallingConfig).toEqual(
        mode ? { mode, ...(names ? { allowedFunctionNames: names } : {}) } : undefined,
      );
      expect(
        wire.request.tools?.flatMap((tool) =>
          tool.functionDeclarations.map((declaration) => declaration.name),
        ),
      ).toEqual(["inspect", "read_file", "read"]);
    } finally {
      await server.stop(true);
    }
  },
);

test("preserves live metadata and applies compat to newly discovered models only in Antigravity", async () => {
  const { modifyModels } = await loadExtension();
  const source = getBundledModels("google-antigravity").find(
    (model) => model.id === "claude-sonnet-5-5",
  );
  const other = getBundledModels("google-gemini-cli")[0];
  if (!source || !other) throw new Error("Missing catalog model");
  const live = {
    ...source,
    id: "new-account-claude-model",
    contextWindow: 123456,
    maxTokens: 9876,
  };
  const rows = modifyModels([live, other]);
  expect(rows[0]).toEqual({
    ...live,
    api: API_ID,
    compatConfig: {
      ...live.compatConfig,
      antigravityClaudeToolMode: false,
      claudeThinkingBetaHeader: false,
    },
  });
  expect(rows[1]).toBe(other);
  expect(live.compatConfig).toBe(source.compatConfig);
});

test("keeps native roster metadata during registration and later profile-less discovery", async () => {
  const { registration, models, projected, modifyModels } = await loadExtension();
  expect(registration.models?.map((model) => model.id)).toEqual(models.map((model) => model.id));
  expect(projected).toEqual(
    models.map((model) => ({
      ...model,
      api: API_ID,
      compatConfig: {
        ...model.compatConfig,
        antigravityClaudeToolMode: false,
        claudeThinkingBetaHeader: false,
      },
    })),
  );
  const original = models[0];
  if (!original) throw new Error("Missing native model");
  const { antigravityWireProfiles: _profiles, ...profileless } = original;
  const refreshed = { ...profileless, contextWindow: 123456, maxTokens: 9876 };
  expect(modifyModels([refreshed])).toEqual([
    {
      ...refreshed,
      api: API_ID,
      compatConfig: {
        ...refreshed.compatConfig,
        antigravityClaudeToolMode: false,
        claudeThinkingBetaHeader: false,
      },
    },
  ]);
});

test("restores the original fetch after overlapping extension lifetimes", async () => {
  const original = globalThis.fetch;
  const first = await loadExtension();
  const second = await loadExtension();
  first.close();
  expect(globalThis.fetch).not.toBe(original);
  second.close();
  expect(globalThis.fetch).toBe(original);
});

test("leaves other provider requests on the original fetch implementation", async () => {
  const { close } = await loadExtension();
  const accept = Promise.withResolvers<string | null>();
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      accept.resolve(request.headers.get("accept"));
      return new Response("OK");
    },
  });
  try {
    expect(
      await (
        await fetch(new URL("/v1internal:streamGenerateContent", server.url.href).href, {
          headers: { "User-Agent": "other-provider" },
        })
      ).text(),
    ).toBe("OK");
    expect(await accept.promise).toBe("*/*");
  } finally {
    close();
    await server.stop(true);
  }
});

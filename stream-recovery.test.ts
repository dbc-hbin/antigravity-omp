import { expect, test } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { loadExtension } from "./extension-fixture";
import { rememberNativeModels } from "./native-models";
import { antigravityFetch } from "./transport";

// AGY 1.5.12 comparison inputs, used only for this loopback fixture.
const idleMs = 10 * 60_000;
const retryCapMs = 4 * 60_000;

function frame(text: string, finished = false): string {
  return `data: ${JSON.stringify({
    response: {
      candidates: [
        {
          content: { role: "model", parts: [{ text }] },
          ...(finished ? { finishReason: "STOP" } : {}),
        },
      ],
    },
  })}\n\n`;
}

function eventStream(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

async function loopbackStream(
  respond: (attempt: number) => Response,
  signal = AbortSignal.timeout(3_000),
) {
  const { projected } = await loadExtension();
  const model = projected.find(({ id }) => id === "gemini-3.8-flash");
  if (!model) throw new TypeError("Missing fixture model");
  const reasoning = THINKING_EFFORTS.find((effort) => effort === "high");
  if (!reasoning) throw new TypeError("Missing fixture reasoning level");
  const token = "local-stream-token";
  rememberNativeModels(`Bearer ${token}`, {
    models: { "gemini-3.8-flash-high": { model: "LOCAL_STREAM_MODEL" } },
  });

  let attempts = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1internal:streamGenerateContent"
      )
        return new Response(null, { status: 404 });
      await request.arrayBuffer();
      return respond(++attempts);
    },
  });
  const origin = server.url.origin;
  const stream = streamSimple(
    { ...model, baseUrl: origin },
    { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] },
    {
      apiKey: JSON.stringify({ token, projectId: "local-fixture" }),
      reasoning,
      signal,
      streamIdleTimeoutMs: idleMs,
      maxRetryDelayMs: retryCapMs,
      headers: { "User-Agent": "antigravity-omp-local" },
      async fetch(input, init) {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin !== origin)
          throw new TypeError("Stream fixture requires its loopback origin");
        const localOptions: BunFetchRequestInit = { ...init, proxy: false, redirect: "error" };
        return antigravityFetch(url, localOptions);
      },
    },
  );
  return {
    stream,
    attempts: () => attempts,
    async [Symbol.asyncDispose]() {
      await server.stop(true);
    },
  };
}

function rateLimit(retryAfter: string): Response {
  return Response.json(
    { error: { message: "Local rate limit" } },
    { status: 429, headers: { "retry-after": retryAfter } },
  );
}

test("recovers a loopback rate limit when the server requests an immediate retry", async () => {
  await using fixture = await loopbackStream((attempt) =>
    attempt === 1 ? rateLimit("0") : eventStream(frame("OK", true)),
  );
  expect(await fixture.stream.result()).toMatchObject({
    stopReason: "stop",
    content: [{ type: "text", text: "OK" }],
  });
  expect(fixture.attempts()).toBe(2);
});

test("does not replay when the server asks for a delay past the four-minute retry cap", async () => {
  await using fixture = await loopbackStream(() => rateLimit("241"));
  expect(await fixture.stream.result()).toMatchObject({ stopReason: "error", errorStatus: 429 });
  expect(fixture.attempts()).toBe(1);
});

test("reports EOF without a final SSE event as an error after delivering the partial text", async () => {
  await using fixture = await loopbackStream(() => eventStream(frame("Partial reply.")));
  let text = "";
  for await (const event of fixture.stream) {
    if (event.type === "text_delta") text += event.delta;
  }
  expect(text).toBe("Partial reply.");
  const result = await fixture.stream.result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("without a finish reason");
});

test("leaves a silent SSE open until the ten-minute idle deadline", async () => {
  const signal = AbortSignal.timeout(3_000);
  mock.timers.enable({ apis: ["Date", "setTimeout"] });
  try {
    await using fixture = await loopbackStream(
      () =>
        eventStream(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame("Partial reply.")));
            },
          }),
        ),
      signal,
    );
    let partial: string | undefined;
    for await (const event of fixture.stream) {
      if (event.type !== "text_delta") continue;
      partial = event.delta;
      break;
    }
    expect(partial).toBe("Partial reply.");

    mock.timers.tick(599_999);
    await setImmediate();
    expect(fixture.stream.resultSettled).toBe(false);

    mock.timers.tick(1);
    const result = await fixture.stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("stalled while waiting for the next event");
  } finally {
    mock.timers.reset();
  }
});

import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import aistudioExtension, { type AistudioProviderConfig } from "./aistudio-provider";

function loadRegistration(): { name: string; config: AistudioProviderConfig } {
  let captured: { name: string; config: AistudioProviderConfig } | undefined;
  aistudioExtension({
    on() {},
    registerProvider(name, config) {
      captured = { name, config };
    },
  });
  if (!captured) throw new Error("provider was not registered");
  return captured;
}

test("registers the native AI Studio provider with its own api and login label", () => {
  const { name, config } = loadRegistration();
  expect(name).toBe("google-aistudio");
  expect(config.api).toBe("aistudio-native");
  expect(config.baseUrl).toBe("https://aistudio.google.com");
  expect(config.oauth.name).toBe("Google AI Studio (web session)");
});

test("streamSimple reports a missing login as an error event without starting the runtime", async () => {
  const { config } = loadRegistration();
  const model = buildModel({
    provider: "google-aistudio",
    api: "aistudio-native",
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    baseUrl: "https://aistudio.google.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  });
  const events: string[] = [];
  let errorMessage = "";
  for await (const event of config.streamSimple(model, { messages: [] })) {
    events.push(event.type);
    if (event.type === "error") errorMessage = event.error.errorMessage ?? "";
  }
  expect(events).toEqual(["error"]);
  expect(errorMessage).toContain("not logged in");
});

test("getApiKey stores the runtime directory and email for later requests", () => {
  const { config } = loadRegistration();
  const key = config.oauth.getApiKey({ access: "", refresh: "", expires: 0, email: "a@example.com", accountId: "/tmp/acct" });
  expect(JSON.parse(key)).toEqual({ directory: "/tmp/acct", email: "a@example.com" });
});

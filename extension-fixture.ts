import { afterEach } from "bun:test";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import antigravityExtension from "./index";

type Registration = Parameters<Parameters<typeof antigravityExtension>[0]["registerProvider"]>[1];
const cleanups: (() => void)[] = [];
const originalVersion = process.env.PI_AI_ANTIGRAVITY_VERSION;
const originalCL = process.env.PI_AI_ANTIGRAVITY_CL;

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  unregisterOAuthProvider("google-antigravity");
  unregisterCustomApis("antigravity-extension-test");
  if (originalVersion === undefined) delete process.env.PI_AI_ANTIGRAVITY_VERSION;
  else process.env.PI_AI_ANTIGRAVITY_VERSION = originalVersion;
  if (originalCL === undefined) delete process.env.PI_AI_ANTIGRAVITY_CL;
  else process.env.PI_AI_ANTIGRAVITY_CL = originalCL;
});

export async function loadExtension() {
  const models = getBundledModels("google-antigravity");
  let projected: Model<Api>[] = models;
  let registration: Registration | undefined;
  let payloadHook: unknown;
  let sessionStart: unknown;
  let shutdown: unknown;
  antigravityExtension({
    on(event, handler) {
      if (event === "before_provider_request") payloadHook = handler;
      if (event === "session_start") sessionStart = handler;
      if (event === "session_shutdown") shutdown = handler;
    },
    async setModel() {
      return true;
    },
    registerProvider(id, config) {
      registration = config;
      registerOAuthProvider({ id, ...config.oauth });
      if (config.streamSimple && config.api)
        registerCustomApi(config.api, config.streamSimple, "antigravity-extension-test");
      if (config.oauth.modifyModels) {
        const bootstrap = models.map(
          ({ antigravityWireProfiles: _profiles, accountAccess: _access, ...row }) => row,
        );
        projected = config.oauth.modifyModels(bootstrap);
      }
    },
  });
  const close = () => {
    if (typeof shutdown !== "function") throw new Error("Missing shutdown hook");
    shutdown();
  };
  cleanups.push(close);
  if (typeof sessionStart !== "function") throw new Error("Missing session start hook");
  await sessionStart(
    {},
    {
      model: models[0],
      modelRegistry: {
        authStorage: { credentials: { async reload() {} } },
        async refreshDiscoverableProviders() {},
        getAll: () => projected,
      },
    },
  );
  if (!registration?.oauth.modifyModels) throw new Error("Missing provider model projection");
  return {
    registration,
    modifyModels: registration.oauth.modifyModels,
    payloadHook,
    close,
    models,
    projected,
  };
}

import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { z } from "zod";

// ModelDetails -> ModelInfo, agy 1.5.6 at 0x100b1afa0. The host catalog
// discards ApiProvider, minimum budget and thought-circulation metadata.
const modelDetails = z.object({
  model: z.string(),
  apiProvider: z.union([z.string(), z.number()]).default(0),
  maxOutputTokens: z.number().default(0),
  supportsThinking: z.boolean().default(false),
  supportsThoughtCirculation: z.boolean().default(false),
  thinkingBudget: z.number().default(0),
  minThinkingBudget: z.number().default(0),
  thinkingLevel: z.number().default(0),
});
const modelRoster = z.object({ models: z.record(z.string(), z.unknown()).default({}) });
const rosters = new Map<string, Record<string, unknown>>();

export function rememberNativeModels(authorization: string, body: unknown): void {
  rosters.set(authorization, modelRoster.parse(body).models);
}

export function nativeModelDetails(
  authorization: string,
  id: string,
): z.infer<typeof modelDetails> {
  const row = rosters.get(authorization)?.[id];
  if (row === undefined)
    throw new ConfigurationError(
      `Native Antigravity metadata for ${id} is unavailable. Refresh the account model roster before generation.`,
    );
  return modelDetails.parse(row);
}

export function clearNativeModels(): void {
  rosters.clear();
}

import { z } from "zod";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";

const json = z.json();
type Json = z.infer<typeof json>;

export const envelope = z.looseObject({
  project: z.string(),
  requestId: z.string(),
  model: z.string(),
  userPromptId: z.string().optional(),
  enabledCreditTypes: z.array(z.union([z.string(), z.number()])).optional(),
  request: z.looseObject({
    labels: z.record(z.string(), z.string()),
    sessionId: z.string(),
    generationConfig: z
      .looseObject({
        thinkingConfig: z
          .looseObject({ thinkingLevel: z.union([z.string(), z.number()]).optional() })
          .optional(),
        responseModalities: z.array(z.union([z.string(), z.number()])).optional(),
      })
      .optional(),
    toolConfig: z
      .looseObject({
        functionCallingConfig: z.looseObject({ mode: z.union([z.string(), z.number()]) }),
      })
      .optional(),
    tools: z
      .array(
        z.looseObject({
          functionDeclarations: z.array(z.looseObject({ parameters: json.optional() })),
        }),
      )
      .optional(),
  }),
});

// Embedded 2.31.0 content.proto enums. The native marshaler switches ALL
// protobuf enums to numbers for EXTRA_HIGH/MAX, including recursive Schema.
const thinkingLevels: Readonly<Record<string, number>> = {
  THINKING_LEVEL_UNSPECIFIED: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  MINIMAL: 4,
  EXTRA_HIGH: 5,
  MAX: 6,
  XHIGH: 7,
};
const toolModes: Readonly<Record<string, number>> = {
  MODE_UNSPECIFIED: 0,
  AUTO: 1,
  ANY: 2,
  NONE: 3,
  COMPOSITIONAL: 4,
  VALIDATED: 5,
  TEST: 6,
};
const modalities: Readonly<Record<string, number>> = {
  MODALITY_UNSPECIFIED: 0,
  TEXT: 1,
  IMAGE: 2,
  AUDIO: 3,
  VIDEO: 4,
};
const schemaTypes: Readonly<Record<string, number>> = {
  TYPE_UNSPECIFIED: 0,
  STRING: 1,
  NUMBER: 2,
  INTEGER: 3,
  BOOLEAN: 4,
  ARRAY: 5,
  OBJECT: 6,
  NULL: 7,
};

function enumNumber(table: Readonly<Record<string, number>>, name: string): number {
  const value = table[name];
  if (value === undefined) throw new ConfigurationError(`Unknown native protobuf enum: ${name}`);
  return value;
}

function nativeSchema(schema: Json, numeric: boolean): Json {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return {};
  const result: Record<string, Json> = {};
  const properties = schema.properties;
  const hasProperties =
    properties !== null && typeof properties === "object" && !Array.isArray(properties);
  const items = schema.items;
  const hasItems = items !== null && typeof items === "object" && !Array.isArray(items);
  const type = typeof schema.type === "string" ? schema.type.toUpperCase() : "";
  const inferredType = schemaTypes[type]
    ? type
    : hasProperties
      ? "OBJECT"
      : hasItems
        ? "ARRAY"
        : "";
  if (inferredType) result.type = numeric ? enumNumber(schemaTypes, inferredType) : inferredType;
  for (const key of ["description", "format", "pattern"]) {
    const value = schema[key];
    if (typeof value === "string" && value) result[key] = value;
  }
  if (hasProperties) {
    const converted = Object.fromEntries(
      Object.entries(properties)
        .filter(([, value]) => value !== null && typeof value === "object" && !Array.isArray(value))
        .map(([key, value]) => [key, nativeSchema(value, numeric)]),
    );
    if (Object.keys(converted).length) result.properties = converted;
    if (Array.isArray(schema.required)) {
      const required = schema.required.filter(
        (value): value is string => typeof value === "string" && Object.hasOwn(converted, value),
      );
      if (required.length) result.required = required;
    }
  }
  if (hasItems) result.items = nativeSchema(items, numeric);
  if (Array.isArray(schema.enum) && schema.enum.length)
    result.enum = schema.enum.map((value) => (typeof value === "string" ? value : ""));
  if (Object.hasOwn(schema, "default")) result.default = schema.default ?? null;
  for (const key of ["minimum", "maximum"]) {
    const value = schema[key];
    if (typeof value === "number" && value !== 0) result[key] = value;
  }
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    const value = schema[key];
    if (typeof value === "number" && Math.trunc(value) !== 0)
      result[key] = BigInt(Math.trunc(value)).toString();
  }
  return result;
}

export function nativeWireRequest(payload: z.infer<typeof envelope>): z.infer<typeof envelope> {
  const generationConfig = { ...payload.request.generationConfig };
  const thinkingConfig = { ...generationConfig.thinkingConfig };
  const level = thinkingConfig.thinkingLevel;
  const numeric = level === "EXTRA_HIGH" || level === "MAX" || level === 5 || level === 6;
  if (numeric && typeof level === "string")
    thinkingConfig.thinkingLevel = enumNumber(thinkingLevels, level);
  else if (!numeric && typeof level === "number")
    thinkingConfig.thinkingLevel =
      Object.entries(thinkingLevels).find(([, value]) => value === level)?.[0] ?? level;
  generationConfig.thinkingConfig = thinkingConfig;
  if (numeric && generationConfig.responseModalities) {
    generationConfig.responseModalities = generationConfig.responseModalities.map((value) =>
      typeof value === "string" ? enumNumber(modalities, value) : value,
    );
  }
  // This CCPA builder does not assign sampling penalties or temperature.
  delete generationConfig.temperature;
  delete generationConfig.topP;
  delete generationConfig.topK;
  delete generationConfig.presencePenalty;
  const toolConfig = payload.request.toolConfig;
  const mode = toolConfig?.functionCallingConfig.mode;
  const tools = payload.request.tools?.flatMap((tool) =>
    tool.functionDeclarations.map((declaration) => ({
      functionDeclarations: [
        {
          ...(declaration.name ? { name: declaration.name } : {}),
          ...(declaration.description ? { description: declaration.description } : {}),
          parameters: nativeSchema(declaration.parameters ?? {}, numeric),
        },
      ],
    })),
  );
  const result = {
    ...payload,
    request: {
      ...payload.request,
      generationConfig,
      ...(tools === undefined ? {} : { tools }),
      ...(toolConfig === undefined
        ? {}
        : {
            toolConfig: {
              ...toolConfig,
              functionCallingConfig: {
                ...toolConfig.functionCallingConfig,
                mode:
                  numeric && typeof mode === "string"
                    ? enumNumber(toolModes, mode)
                    : toolConfig.functionCallingConfig.mode,
              },
            },
          }),
    },
  };
  // Explicitly cleared by native StreamGenerateContent. AI-credit spending
  // is opt-in in Antigravity; this extension has no such opt-in source.
  delete result.userPromptId;
  delete result.enabledCreditTypes;
  if (!tools?.length) delete result.request.tools;
  return result;
}

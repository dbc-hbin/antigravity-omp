// Ported from AIStudio2API bab7209eef0d5a8f9baed4652d7e4158a3adad7b.
// Copyright (c) 2026 Mag1cFall. MIT; see aistudio-runtime/LICENSE.
import type { GenerateContentParameters, GenerateContentResponse } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { StudioModel } from "./aistudio-catalog";
import { array, object, number, string, json, encodeSchema, encodeStruct, decodeStruct, wireFunctionName, StudioProtocolError, type Json } from "./aistudio-schema";
import { frames } from "./aistudio-stream";
export type { Json } from "./aistudio-schema";
export { StudioProtocolError } from "./aistudio-schema";
type Part = NonNullable<GenerateContentParameters["contents"][number]["parts"]>[number];
type FinishReason = NonNullable<NonNullable<GenerateContentResponse["candidates"]>[number]["finishReason"]>;

function encodePart(part: Part): Json[] {
  const wire: Json[] = Array.from({length:15}, () => null);
  if (part.text !== undefined) wire[1] = part.text;
  if (part.inlineData) wire[2] = [part.inlineData.mimeType, part.inlineData.data];
  if (part.fileData) wire[6] = [part.fileData.mimeType ?? "", part.fileData.fileUri];
  if (part.functionCall) {
    const call = part.functionCall;
    if (!call.name) throw new StudioProtocolError("functionCall.name", "missing name");
    wire[10] = [wireFunctionName(call.name), encodeStruct(object(json.parse(call.args ?? {}), "functionCall.args")), ...(call.id === undefined ? [] : [call.id])];
  }
  if (part.functionResponse) {
    const response = part.functionResponse;
    if (response.parts?.length) throw new StudioProtocolError("functionResponse.parts", "multimodal function results are not supported by this transport");
    wire[11] = [wireFunctionName(response.name), encodeStruct(object(json.parse(response.response), "functionResponse.response")), ...(response.id === undefined ? [] : [response.id])];
  }
  if (part.thought !== undefined) wire[12] = part.thought;
  if (part.thoughtSignature !== undefined) wire[14] = part.thoughtSignature;
  while (wire.length && wire[wire.length-1] === null) wire.pop();
  return wire;
}

const harmCategories: Readonly<Record<string, number>> = {HARM_CATEGORY_HARASSMENT:7, HARM_CATEGORY_HATE_SPEECH:8, HARM_CATEGORY_SEXUALLY_EXPLICIT:9, HARM_CATEGORY_DANGEROUS_CONTENT:10, HARM_CATEGORY_CIVIC_INTEGRITY:11};
const thresholds: Readonly<Record<string, number>> = {BLOCK_LOW_AND_ABOVE:1, BLOCK_MEDIUM_AND_ABOVE:2, BLOCK_ONLY_HIGH:3, BLOCK_NONE:4, OFF:5};
const levels: Readonly<Record<string, number>> = {MINIMAL:4, LOW:1, MEDIUM:2, HIGH:3};

export function encodeRequest(model: StudioModel, params: GenerateContentParameters): {body:Json[];prompt:string} {
  const config = params.config ?? {};
  if (!params.contents.length) throw new StudioProtocolError("contents", "empty conversation");
  if (config.cachedContent || config.serviceTier || config.presencePenalty !== undefined || config.frequencyPenalty !== undefined || config.candidateCount !== undefined && config.candidateCount !== 1) throw new StudioProtocolError("config", "requested option requires a different upstream transport");
  if (config.responseModalities?.some(v => v !== "TEXT")) throw new StudioProtocolError("responseModalities", "this provider serves text chat");
  const contents: Json[] = params.contents.map(content => [(content.parts ?? []).map(encodePart), content.role === "model" ? "model" : "user"]);
  const prompt = params.contents.flatMap(content => (content.parts ?? []).flatMap(part => part.text === undefined ? [] : [part.text])).join(" ");
  const generation: Json[] = Array.from({length:14}, () => null);
  generation[1] = config.stopSequences?.length ? config.stopSequences : null;
  const maxOutput = config.maxOutputTokens ?? model.maxTokens;
  if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0) throw new StudioProtocolError("maxOutputTokens", "expected positive integer");
  generation[3] = Math.min(maxOutput, model.maxTokens);
  for (const [slot, value, limit] of [[4,config.temperature ?? model.defaults.temperature,2],[5,config.topP ?? model.defaults.topP,1],[6,config.topK ?? model.defaults.topK,Infinity]] satisfies [number,number|null|undefined,number][]) {
    if (value != null) {
      if (!Number.isFinite(value) || value < 0 || value > limit || slot === 6 && !Number.isInteger(value)) throw new StudioProtocolError("sampling", "invalid sampling value");
      generation[slot] = value;
    }
  }
  generation[7] = config.responseMimeType ?? null;
  const schema = config.responseJsonSchema ?? config.responseSchema;
  if (schema) generation[8] = encodeSchema(json.parse(schema));
  generation[13] = 1;
  if (config.responseModalities) generation[14] = [1];
  if (model.reasoning) {
    while (generation.length <= 16) generation.push(null);
    const thinking = config.thinkingConfig;
    let budget = thinking?.thinkingBudget;
    let level = thinking?.thinkingLevel && levels[thinking.thinkingLevel];
    if (model.defaults.thinkingLevel) {
      if (!level && budget !== undefined && !model.defaults.thinkingBudget) level = budget < 0 ? model.defaults.defaultThinkingLevel : budget === 0 ? 4 : budget <= 1024 ? 1 : budget <= 8192 ? 2 : 3;
      level ||= model.defaults.defaultThinkingLevel;
      if (model.defaults.thinkingLevels.length && !model.defaults.thinkingLevels.includes(level)) {
        const order = [4,1,2,3];
        const supported = order.filter(v => model.defaults.thinkingLevels.includes(v));
        const requested = level;
        level = supported.find(v => order.indexOf(v) >= order.indexOf(requested)) ?? supported[supported.length-1];
        if (level === undefined) throw new StudioProtocolError("thinkingLevel", "catalog has no supported thinking level");
      }
    } else level = undefined;
    if (!model.defaults.thinkingBudget) budget = undefined;
    if (budget !== undefined && (!Number.isInteger(budget) || budget < -1)) throw new StudioProtocolError("thinkingBudget", "expected -1 or nonnegative integer");
    const bounds = model.defaults.budget;
    if (budget !== undefined && budget >= 0 && bounds) {
      if (budget === 0 && !bounds.canDisable) budget = bounds.min ?? bounds.default ?? -1;
      else if (budget > 0) budget = Math.max(bounds.min ?? 0, Math.min(bounds.max ?? Infinity, budget));
    }
    generation[16] = level === undefined ? [1, ...(budget === undefined ? [] : [budget])] : [1,budget ?? null,null,level];
  }
  if (config.seed !== undefined) { while (generation.length <= 18) generation.push(null); generation[18] = config.seed; }
  const safety = new Map<number,number>([[7,5],[8,5],[9,5],[10,5]]);
  for (const setting of config.safetySettings ?? []) {
    const category = typeof setting["category"] === "number" ? setting["category"] : harmCategories[String(setting["category"])];
    const threshold = typeof setting["threshold"] === "number" ? setting["threshold"] : thresholds[String(setting["threshold"])];
    if (category === undefined || threshold === undefined || category < 7 || category > 11 || threshold < 1 || threshold > 5) throw new StudioProtocolError("safetySettings", "unsupported category or threshold");
    safety.set(category, threshold);
  }
  const body: Json[] = Array.from({length:11}, () => null);
  body[0] = `models/${model.id}`;
  body[1] = contents;
  body[2] = [...safety].map(([category,threshold]) => [null,null,category,threshold]);
  body[3] = generation;
  if (config.systemInstruction) body[5] = [(config.systemInstruction.parts ?? []).map(encodePart), "user"];
  const choice = config.toolConfig?.functionCallingConfig;
  const declarations = (config.tools ?? []).flatMap(tool => tool.functionDeclarations);
  if (declarations.length && !model.capabilities.includes(10)) throw new StudioProtocolError("tools", "model does not advertise function declarations");
  if (choice && !["AUTO","MODE_UNSPECIFIED","NONE"].includes(choice.mode)) throw new StudioProtocolError("toolConfig", "Playground has no verified forced function-calling mode");
  if (choice?.mode !== "NONE") {
    const encoded: Json[] = [];
    for (const raw of declarations) {
      const declaration = object(json.parse(raw), "functionDeclaration");
      const name = string(declaration["name"], "functionDeclaration.name");
      if (choice?.allowedFunctionNames && !choice.allowedFunctionNames.includes(name)) continue;
      const parameters = declaration["parametersJsonSchema"] ?? declaration["parameters"];
      const description = declaration["description"] == null ? "" : string(declaration["description"], "functionDeclaration.description");
      encoded.push(parameters == null ? [wireFunctionName(name), description] : [wireFunctionName(name), `${description}\nArguments must follow this JSON Schema: ${JSON.stringify(parameters)}`, encodeSchema(parameters)]);
    }
    if (encoded.length) body[6] = [[null,encoded]];
  }
  if (model.outputContinuation) { while (generation.length <= 45) generation.push(null); generation[45] = 1; }
  else body[10] = 1;
  return {body,prompt};
}

const finishReasons: Readonly<Record<number, FinishReason>> = {0:"FINISH_REASON_UNSPECIFIED",1:"STOP",2:"MAX_TOKENS",3:"SAFETY",4:"RECITATION",5:"OTHER",6:"LANGUAGE",7:"BLOCKLIST",8:"PROHIBITED_CONTENT",9:"SPII",10:"MALFORMED_FUNCTION_CALL",11:"IMAGE_SAFETY",12:"UNEXPECTED_TOOL_CALL",14:"IMAGE_PROHIBITED_CONTENT",15:"IMAGE_OTHER",16:"NO_IMAGE",17:"IMAGE_RECITATION",19:"MALFORMED_RESPONSE"};

/** Supply the request params to restore upstream's shortened function names. */
export async function* decodeResponse(source: ReadableStream<Uint8Array>, onTurnToken?: (token:string)=>void, params?: GenerateContentParameters): AsyncGenerator<GenerateContentResponse> {
  const originals = new Map<string,string>();
  for (const declaration of (params?.config?.tools ?? []).flatMap(tool => tool.functionDeclarations)) {
    if (typeof declaration["name"] === "string") originals.set(wireFunctionName(declaration["name"]), declaration["name"]);
  }
  let finished = false;
  let terminal: GenerateContentResponse | undefined;
  for await (const frame of frames(source)) {
    const response: GenerateContentResponse = {};
    if (frame[7] != null) onTurnToken?.(string(frame[7], "frame.turnToken"));
    if (frame[2] != null) {
      const usage = array(frame[2], "frame.usage");
      response.usageMetadata = {};
      const fields = [[0,"promptTokenCount"],[1,"candidatesTokenCount"],[2,"totalTokenCount"],[3,"cachedContentTokenCount"],[9,"thoughtsTokenCount"]] as const;
      for (const [slot,name] of fields) if (usage[slot] != null) response.usageMetadata[name] = number(usage[slot], `usage.${name}`);
    }
    if (frame[1] != null && frame[0] == null) {
      const feedback = array(frame[1], "promptFeedback");
      response.promptFeedback = {blockReason:typeof feedback[0] === "string" ? feedback[0] : "UNKNOWN", ...(feedback[2] == null ? {} : {blockReasonMessage:string(feedback[2], "promptFeedback.message")})};
      finished = true;
    }
    if (frame[0] != null) {
      response.candidates = [];
      for (const raw of array(frame[0], "candidates")) {
        const candidate = array(raw, "candidate");
        const parts: Part[] = [];
        if (candidate[0] != null) {
          const content = array(candidate[0], "candidate.content");
          for (const rawPart of content[0] == null ? [] : array(content[0], "content.parts")) {
            const wire = array(rawPart, "part");
            const part: Part = {};
            if (wire[1] != null) part.text = string(wire[1], "part.text");
            if (wire[12] != null) {
              if (typeof wire[12] !== "boolean" && wire[12] !== 0 && wire[12] !== 1) throw new StudioProtocolError("part.thought", "expected boolean");
              part.thought = wire[12] === true || wire[12] === 1;
            }
            if (wire[14] != null) part.thoughtSignature = string(wire[14], "part.signature");
            if (wire[2] != null) { const data = array(wire[2], "part.inlineData"); part.inlineData = {mimeType:string(data[0], "inline.mime"),data:string(data[1], "inline.data")}; }
            for (const slot of [10,11]) {
              if (wire[slot] == null) continue;
              const call = array(wire[slot], "part.function");
              const name = string(call[0], "function.name");
              const restored = originals.get(name) ?? name;
              const args = call[1] == null ? {} : decodeStruct(call[1]);
              const id = call[2] == null ? {} : {id:string(call[2], "function.id")};
              if (slot === 10) part.functionCall = {name:restored,args,...id};
              else part.functionResponse = {name:restored,response:args,...id};
            }
            parts.push(part);
          }
        }
        const output: NonNullable<GenerateContentResponse["candidates"]>[number] & {finishMessage?:string; providerFinishReason?:string} = {content:{role:"model",parts}};
        if (candidate[1] != null) {
          const code = number(candidate[1], "candidate.finishReason");
          output.finishReason = finishReasons[code] ?? "OTHER";
          if (!finishReasons[code]) { output.providerFinishReason = `provider_${code}`; output.finishMessage = `AI Studio finish reason ${code}`; }
          if (candidate[3] != null) output.finishMessage = string(candidate[3], "candidate.finishMessage");
          finished = code !== 0;
        }
        response.candidates.push(output);
      }
    }
    if (response.candidates?.some(c => c.finishReason !== undefined && c.finishReason !== "FINISH_REASON_UNSPECIFIED") || response.promptFeedback) {
      terminal = response;
      if (response.candidates?.some(c => c.content?.parts?.length)) {
        yield {...response, candidates:response.candidates.map(c => (c.content ? {content:c.content} : {}))};
        terminal = {...response, candidates:response.candidates.map(c => ({...c, content:{role:"model",parts:[]}}))};
      }
    }
    else yield response;
  }
  if (!finished) throw new StudioProtocolError("stream", "ended without a finish frame");
  if (terminal) yield terminal;
}

// Ported from AIStudio2API bab7209eef0d5a8f9baed4652d7e4158a3adad7b.
// Copyright (c) 2026 Mag1cFall. MIT; see aistudio-runtime/LICENSE.
import { array, json, number, string, StudioProtocolError } from "./aistudio-schema";

export interface StudioModel {
  readonly id: string;
  readonly name: string;
  readonly reasoning: boolean;
  readonly input: ("text" | "image")[];
  readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly capabilities: readonly number[];
  readonly accessModes: readonly number[];
  readonly defaults: {
    readonly temperature: number | null;
    readonly topP: number | null;
    readonly topK: number | null;
    readonly thinkingBudget: boolean;
    readonly thinkingLevel: boolean;
    readonly defaultThinkingLevel: number;
    readonly thinkingLevels: readonly number[];
    readonly budget: { readonly default: number | null; readonly min: number | null; readonly max: number | null; readonly canDisable: boolean } | null;
  };
  readonly outputContinuation: boolean;
  readonly thinking?: {
    readonly mode: "google-level" | "budget";
    readonly efforts: readonly ("minimal" | "low" | "medium" | "high")[];
    readonly defaultLevel?: "minimal" | "low" | "medium" | "high";
    readonly effortBudgets?: Readonly<Partial<Record<"minimal" | "low" | "medium" | "high", number>>>;
  };
}
export function parseBenefitTier(tier: unknown): number {
  const root = array(json.parse(tier), "GetAiStudioBenefitTier");
  const value = root[0] == null ? 0 : number(root[0], "GetAiStudioBenefitTier[0]");
  if (!Number.isInteger(value) || value < 0 || value > 3) throw new StudioProtocolError("GetAiStudioBenefitTier[0]", "unknown benefit tier");
  return value;
}
export function parseCatalog(models: unknown, tier: unknown): StudioModel[] {
  const benefit = parseBenefitTier(tier);
  const root = array(json.parse(models), "ListModels");
  const rows = array(root[0], "ListModels[0]");
  const seen = new Set<string>();
  const result: StudioModel[] = [];
  for (const raw of rows) {
    const row = array(raw, "ListModels.row");
    const id = string(row[0], "model.id").replace(/^models\//, "");
    if (!id || seen.has(id)) throw new StudioProtocolError("model.id", "empty or duplicate model ID");
    seen.add(id);
    const codes = row[64] == null ? [] : array(row[64], "model.capabilities").map(v => number(v, "capability"));
    const accessModes = row[82] == null ? [] : array(row[82], "model.accessModes").map(v => number(v, "accessMode"));
    const methods = row[7] == null ? [] : array(row[7], "model.methods").map(v => string(v, "method"));
    if (!methods.includes("generateContent") || !codes.includes(1) || row[78] != null || codes.some(c => [20,21,26,37,53].includes(c))) continue;
    if (accessModes.length && !accessModes.some(mode => mode === 3 && (benefit === 1 || benefit === 2) || mode === 4 && benefit === 2)) continue;
    const contextWindow = number(row[5], "model.inputTokenLimit");
    const maxTokens = number(row[6], "model.outputTokenLimit");
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new StudioProtocolError("model.limits", "missing or invalid token limits");
    const thinking = row[71] == null ? [] : array(row[71], "model.thinking");
    const optional = (v: typeof row[number] | undefined) => v == null ? null : number(v, "model.default");
    const thinkingLevels = thinking[6] == null ? [] : array(thinking[6], "thinking.levels").map(v => number(v, "thinking.level"));
    const efforts = ([["minimal",4],["low",1],["medium",2],["high",3]] as const).filter(([,code]) => thinkingLevels.includes(code)).map(([name]) => name);
    const defaultLevel = ([["minimal",4],["low",1],["medium",2],["high",3]] as const).find(([,code]) => code === (optional(thinking[5]) || 2))?.[0];
    const budgetEfforts = ([["low",thinking[2]],["medium",thinking[0]],["high",thinking[1]]] as const).flatMap(([name,value]) => value == null || number(value,"thinking.budget") < 0 ? [] : [{name,value:number(value,"thinking.budget")}]);
    result.push({id, name:string(row[3], "model.name"), reasoning:codes.some(c => [25,35,52].includes(c)), input:["text", "image"], cost:{input:0, output:0, cacheRead:0, cacheWrite:0}, contextWindow, maxTokens:codes.includes(91) ? Math.min(maxTokens,32768) : maxTokens, capabilities:codes, accessModes,
      ...(codes.includes(52) && efforts.length ? {thinking:{mode:"google-level",efforts,...(defaultLevel && efforts.includes(defaultLevel) ? {defaultLevel} : {})} as const} : {}),
      ...(!codes.includes(52) && codes.includes(35) && budgetEfforts.length ? {thinking:{mode:"budget",efforts:budgetEfforts.map(v => v.name),effortBudgets:Object.fromEntries(budgetEfforts.map(v => [v.name,v.value]))} as const} : {}),
      outputContinuation:codes.includes(91), defaults:{temperature:optional(row[8]), topP:optional(row[9]), topK:optional(row[10]), thinkingBudget:codes.includes(35), thinkingLevel:codes.includes(52), defaultThinkingLevel:optional(thinking[5]) || 2, thinkingLevels:thinking[6] == null ? [] : array(thinking[6], "thinking.levels").map(v => number(v, "thinking.level")), budget:row[71] == null || !codes.includes(35) ? null : {default:optional(thinking[0]), max:optional(thinking[1]), min:optional(thinking[2]), canDisable:thinking[3] != null && number(thinking[3], "thinking.canDisable") !== 0}}});
  }
  return result;
}

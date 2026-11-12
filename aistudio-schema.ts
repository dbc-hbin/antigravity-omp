// Ported from AIStudio2API bab7209eef0d5a8f9baed4652d7e4158a3adad7b.
// Copyright (c) 2026 Mag1cFall. MIT; see aistudio-runtime/LICENSE.
import { z } from "zod";
import { createHash } from "node:crypto";

export const json = z.json();
export type Json = z.infer<typeof json>;
export class StudioProtocolError extends Error {
  constructor(readonly path: string, detail: string, readonly code?: number) {
    super(`AI Studio ${path}: ${detail}`);
    this.name = "StudioProtocolError";
  }
}
export function array(value: Json | undefined, path: string): Json[] {
  if (!Array.isArray(value)) throw new StudioProtocolError(path, "expected array");
  return value;
}
export function object(value: Json | undefined, path: string): Record<string, Json> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StudioProtocolError(path, "expected object");
  return value;
}
export function string(value: Json | undefined, path: string): string {
  if (typeof value !== "string") throw new StudioProtocolError(path, "expected string");
  return value;
}
export function number(value: Json | undefined, path: string): number {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) throw new StudioProtocolError(path, "expected number");
  return parsed;
}
export function wireFunctionName(name: string): string {
  const bytes = Buffer.from(name);
  return bytes.length <= 63 ? name : bytes.subarray(0, 50).toString() + "_" + createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}
export function encodeStruct(value: Record<string, Json>): Json[] {
  const entries = Object.keys(value).sort().map(key => [key, encodeValue(value[key] ?? null)]);
  return entries.length ? [entries] : [];
}
function encodeValue(value: Json): Json[] {
  if (value === null) return [0];
  switch (typeof value) {
    case "number": return [null, value];
    case "string": return [null, null, value];
    case "boolean": return [null, null, null, value];
    case "object": return Array.isArray(value) ? [null, null, null, null, null, [value.map(encodeValue)]] : [null, null, null, null, encodeStruct(value)];
    default: throw new StudioProtocolError("Value", "unsupported JSON value");
  }
}
export function decodeStruct(value: Json): Record<string, Json> {
  const fields = array(value, "Struct");
  const result: Record<string, Json> = {};
  for (const item of fields[0] == null ? [] : array(fields[0], "Struct.entries")) {
    const entry = array(item, "Struct.entry");
    if (entry.length !== 2) throw new StudioProtocolError("Struct.entry", "expected key and value");
    result[string(entry[0], "Struct.key")] = decodeValue(entry[1]);
  }
  return result;
}
function decodeValue(value: Json | undefined): Json {
  const fields = array(value, "Value");
  const variants = fields.slice(0, 6).flatMap((v, i) => v == null ? [] : [i]);
  if (variants.length !== 1) throw new StudioProtocolError("Value", "expected exactly one variant");
  switch (variants[0]) {
    case 0: if (number(fields[0], "Value.null") !== 0) throw new StudioProtocolError("Value.null", "invalid enum"); return null;
    case 1: return number(fields[1], "Value.number");
    case 2: return string(fields[2], "Value.string");
    case 3:
      if (typeof fields[3] !== "boolean" && fields[3] !== 0 && fields[3] !== 1) throw new StudioProtocolError("Value.bool", "expected boolean");
      return fields[3] === true || fields[3] === 1;
    case 4: return decodeStruct(fields[4] ?? null);
    case 5: { const list = array(fields[5], "Value.list"); return list[0] == null ? [] : array(list[0], "Value.items").map(decodeValue); }
    default: throw new StudioProtocolError("Value", "unknown variant");
  }
}
const schemaSlots: Readonly<Record<string, number>> = { type:0, format:1, description:2, nullable:3, enum:4, items:5, properties:6, required:7, minProperties:8, maxProperties:9, minimum:10, maximum:11, minLength:12, maxLength:13, pattern:14, example:15, oneOf:16, anyOf:17, allOf:18, not:19, maxItems:20, minItems:21, propertyOrdering:22 };
const types: Readonly<Record<string, number>> = { string:1, number:2, integer:3, boolean:4, array:5, object:6 };
/** Recursive Gemini/JSON Schema projection; unsupported constraints stay in declaration prose. */
export function encodeSchema(value: Json, root: Json = value, refs: readonly string[] = []): Json[] {
  if (value === false) throw new StudioProtocolError("schema", "schema forbids all values");
  const node = value === true ? {} : object(value, "schema");
  if (typeof node["$ref"] === "string") {
    const ref = node["$ref"];
    if (!ref.startsWith("#/") || refs.includes(ref)) throw new StudioProtocolError("schema.$ref", "external or circular reference");
    let target: Json = root;
    for (const key of ref.slice(2).split("/")) target = object(target, "schema.$ref")[key.replaceAll("~1", "/").replaceAll("~0", "~")] ?? null;
    return encodeSchema(target, root, [...refs, ref]);
  }
  const wire: Json[] = [0];
  for (const [key, original] of Object.entries(node)) {
    const slot = schemaSlots[key];
    if (slot === undefined) continue;
    let item: Json = original;
    switch (key) {
      case "type": {
        const names = Array.isArray(item) ? item.map(v => string(v, "schema.type")) : [string(item, "schema.type")];
        const nonNull = names.filter(n => n.toLowerCase() !== "null");
        if (names.length !== nonNull.length) { while (wire.length <= 3) wire.push(null); wire[3] = true; }
        if (nonNull.length > 1) { while (wire.length <= 17) wire.push(null); wire[17] = nonNull.map(type => encodeSchema({type}, root, refs)); }
        item = nonNull.length === 1 ? types[nonNull[0]?.toLowerCase() ?? ""] ?? 0 : 0;
        break;
      }
      case "items": case "not": item = encodeSchema(item, root, refs); break;
      case "properties": item = Object.entries(object(item, "schema.properties")).sort(([a],[b]) => a.localeCompare(b)).map(([name, child]) => [name, encodeSchema(child, root, refs)]); break;
      case "oneOf": case "anyOf": case "allOf": item = array(item, `schema.${key}`).map(child => encodeSchema(child, root, refs)); break;
      case "example": item = encodeValue(item); break;
    }
    while (wire.length <= slot) wire.push(null);
    wire[slot] = item;
  }
  if (wire[0] === 0) {
    const variants = wire[16] ?? wire[17] ?? wire[18];
    const first = Array.isArray(variants) ? variants[0] : undefined;
    wire[0] = node["properties"] ? 6 : node["items"] ? 5 : Array.isArray(first) ? first[0] ?? 1 : 1;
  }
  return wire;
}

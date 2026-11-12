// Ported from AIStudio2API bab7209eef0d5a8f9baed4652d7e4158a3adad7b.
// Copyright (c) 2026 Mag1cFall. MIT; see aistudio-runtime/LICENSE.
import { array, json, number, string, StudioProtocolError, type Json } from "./aistudio-schema";

async function* tokens(source: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = source.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let quoted = false;
  let escaped = false;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      const text = chunk.done ? decoder.decode() : decoder.decode(chunk.value, {stream:true});
      for (const char of text) {
        if (quoted) {
          pending += char;
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') { quoted = false; yield pending; pending = ""; }
        } else if (char === '"') {
          if (pending) throw new StudioProtocolError("stream", "invalid string boundary");
          quoted = true; pending = char;
        } else if ("[]{}:,".includes(char) || /\s/.test(char)) {
          if (pending) { yield pending; pending = ""; }
          if (!/\s/.test(char)) yield char;
        } else pending += char;
      }
      if (chunk.done) { complete = true; break; }
    }
    if (quoted) throw new StudioProtocolError("stream", "truncated string");
    if (pending) yield pending;
  } finally {
    try { if (!complete) await reader.cancel(); } finally { reader.releaseLock(); }
  }
}

class Parser {
  private next: IteratorResult<string> | undefined;
  constructor(private readonly source: AsyncGenerator<string>) {}
  async peek(): Promise<string | undefined> {
    this.next ??= await this.source.next();
    return this.next.done ? undefined : this.next.value;
  }
  async take(): Promise<string> {
    const token = await this.peek();
    this.next = undefined;
    if (token === undefined) throw new StudioProtocolError("stream", "truncated JSON root");
    return token;
  }
  async expect(expected: string): Promise<void> {
    if (await this.take() !== expected) throw new StudioProtocolError("stream", `expected ${expected}`);
  }
  async value(): Promise<Json> {
    const first = await this.peek();
    if (first === "[") {
      await this.take();
      const values: Json[] = [];
      for await (const item of this.items()) values.push(item);
      return values;
    }
    if (first === "{") {
      await this.take();
      const value: Record<string, Json> = {};
      if (await this.peek() !== "}") {
        while (true) {
          const key = string(json.parse(JSON.parse(await this.take())), "JSON.key");
          await this.expect(":");
          value[key] = await this.value();
          if (await this.peek() !== ",") break;
          await this.take();
        }
      }
      await this.expect("}");
      return value;
    }
    return json.parse(JSON.parse(await this.take()));
  }
  async *items(): AsyncGenerator<Json> {
    if (await this.peek() === "]") { await this.take(); return; }
    while (true) {
      if (await this.peek() === ",") yield null;
      else yield await this.value();
      const delimiter = await this.take();
      if (delimiter === "]") return;
      if (delimiter !== ",") throw new StudioProtocolError("stream", "expected array separator");
      if (await this.peek() === "]") { yield null; await this.take(); return; }
    }
  }
}

/** Consume every root field, including a late google.rpc error after the frame list. */
export async function* frames(source: ReadableStream<Uint8Array>): AsyncGenerator<Json[]> {
  const iterator = tokens(source);
  const parser = new Parser(iterator);
  try {
    await parser.expect("[");
    if (await parser.peek() === "[") {
      await parser.take();
      for await (const frame of parser.items()) yield array(frame, "frame");
    } else if (await parser.peek() === "null" || await parser.peek() === ",") {
      if (await parser.peek() === "null") await parser.take();
    } else throw new StudioProtocolError("$[0]", "expected repeated frames");
    let field = 1;
    while (await parser.peek() === ",") {
      await parser.take();
      const token = await parser.peek();
      const value = token === "," || token === "]" ? null : await parser.value();
      if (field === 1) {
        const status = array(value, "$[1]");
        const code = number(status[0], "$[1][0]");
        if (code !== 0) throw new StudioProtocolError("GenerateContent", status[1] == null ? `RPC status ${code}` : string(status[1], "$[1][1]"), code);
      }
      field++;
    }
    await parser.expect("]");
    if (await parser.peek() !== undefined) throw new StudioProtocolError("stream", "multiple JSON roots");
  } finally { await iterator.return(undefined); }
}

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConfigurationError, GoogleApiError, ProviderResponseError } from "@oh-my-pi/pi-ai/error";
import { z } from "zod";
import type { Json } from "./aistudio-schema";

const eventSchema = z.discriminatedUnion("event", [
  z.object({ id: z.string(), event: z.literal("progress"), message: z.string() }),
  z.object({ id: z.string(), event: z.literal("result"), data: z.unknown() }),
  z.object({ id: z.string(), event: z.literal("headers"), status: z.number().int(), headers: z.record(z.string(), z.string()) }),
  z.object({ id: z.string(), event: z.literal("chunk"), data: z.string() }),
  z.object({ id: z.string(), event: z.literal("end") }),
  z.object({ id: z.string(), event: z.literal("error"), message: z.string(), status: z.number().int().optional() }),
]);
type RuntimeEvent = z.infer<typeof eventSchema>;
type Command = Readonly<Record<string, Json | undefined>>;
type Pending = {
  readonly event: (event: RuntimeEvent) => void;
  readonly fail: (error: Error) => void;
};

function transportError(message: string): ProviderResponseError {
  return new ProviderResponseError(message, { provider: "google-aistudio", kind: "runtime" });
}

/** Owns the bundled Camoufox process and multiplexes its actual response bytes. */
export class AistudioRuntime {
  #process: Bun.Subprocess<"pipe", "pipe", "inherit"> | undefined;
  #starting: Promise<Bun.Subprocess<"pipe", "pipe", "inherit">> | undefined;
  readonly #pending = new Map<string, Pending>();
  #closed = false;

  async #start(): Promise<Bun.Subprocess<"pipe", "pipe", "inherit">> {
    if (this.#closed) throw transportError("AI Studio runtime has closed.");
    if (this.#process) return this.#process;
    if (this.#starting) return this.#starting;
    this.#starting = (async () => {
      const directory = join(import.meta.dir, "aistudio-runtime");
      const executable = join(directory, "bin", "aistudio-runtime");
      if (!(await Bun.file(executable).exists())) {
        const build = Bun.spawn(["go", "build", "-trimpath", "-o", executable, "./cmd/aistudio-runtime"], {
          cwd: directory,
          env: { ...process.env, GOTOOLCHAIN: "local", CGO_ENABLED: "0" },
          stdout: "ignore",
          stderr: "pipe",
        });
        const [code, detail] = await Promise.all([build.exited, new Response(build.stderr).text()]);
        if (code !== 0) throw new ConfigurationError(`Cannot build AI Studio runtime: ${detail.trim()}`);
      }
      if (this.#closed) throw transportError("AI Studio runtime closed during startup.");
      const child = Bun.spawn([executable], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      this.#process = child;
      void this.#read(child);
      return child;
    })();
    try {
      return await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #read(child: Bun.Subprocess<"pipe", "pipe", "inherit">): Promise<void> {
    let failure: Error | undefined;
    try {
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const bytes of child.stdout) {
        buffered += decoder.decode(bytes, { stream: true });
        let end: number;
        while ((end = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, end);
          buffered = buffered.slice(end + 1);
          if (!line.trim()) continue;
          const event = eventSchema.parse(JSON.parse(line));
          this.#pending.get(event.id)?.event(event);
        }
      }
      buffered += decoder.decode();
      if (buffered.trim()) throw transportError("AI Studio runtime returned an incomplete protocol message.");
      const code = await child.exited;
      if (!this.#closed || code !== 0) failure = transportError(`AI Studio runtime exited with code ${code}.`);
    } catch (error) {
      failure = error instanceof Error ? error : transportError(String(error));
      child.kill();
    } finally {
      this.#process = undefined;
      const error = failure ?? transportError("AI Studio runtime closed.");
      for (const pending of this.#pending.values()) pending.fail(error);
      this.#pending.clear();
    }
  }

  async #dispatch(
    command: Command,
    pending: Pending,
    signal?: AbortSignal,
  ): Promise<() => void> {
    signal?.throwIfAborted();
    const child = await this.#start();
    signal?.throwIfAborted();
    const id = randomUUID();
    const abort = () => {
      void child.stdin.write(`${JSON.stringify({ id: randomUUID(), method: "cancel", target: id })}\n`);
      this.#pending.delete(id);
      pending.fail(signal?.reason instanceof Error ? signal.reason : new DOMException("Cancelled", "AbortError"));
    };
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      this.#pending.delete(id);
    };
    this.#pending.set(id, {
      event: (event) => {
        if (event.event === "result" || event.event === "end" || event.event === "error") finish();
        pending.event(event);
      },
      fail: (error) => { finish(); pending.fail(error); },
    });
    signal?.addEventListener("abort", abort, { once: true });
    void child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    await child.stdin.flush();
    return finish;
  }

  async request(command: Command, signal?: AbortSignal, progress?: (message: string) => void): Promise<unknown> {
    const result = Promise.withResolvers<unknown>();
    await this.#dispatch(command, {
      event(event) {
        switch (event.event) {
          case "progress": progress?.(event.message); break;
          case "result": result.resolve(event.data); break;
          case "error": result.reject(event.status ? new GoogleApiError(event.message, event.status) : transportError(event.message)); break;
          default: result.reject(transportError(`Unexpected ${event.event} response from the AI Studio runtime.`));
        }
      },
      fail: result.reject,
    }, signal);
    return result.promise;
  }

  async generate(command: Command, signal?: AbortSignal): Promise<Response> {
    const response = Promise.withResolvers<Response>();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let complete = false;
    const fail = (error: Error) => {
      if (complete) return;
      complete = true;
      response.reject(error);
      controller?.error(error);
    };
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel(reason) { abort.abort(reason); },
    });
    await this.#dispatch({ ...command, method: "generate" }, {
      event(event) {
        switch (event.event) {
          case "headers": response.resolve(new Response(body, { status: event.status, headers: event.headers })); break;
          case "chunk": controller?.enqueue(Buffer.from(event.data, "base64")); break;
          case "end": complete = true; controller?.close(); break;
          case "error": fail(event.status ? new GoogleApiError(event.message, event.status) : transportError(event.message)); break;
          case "progress": break;
          case "result": fail(transportError("AI Studio generation returned a unary result.")); break;
        }
      },
      fail,
    }, combined);
    return response.promise;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const child = this.#process ?? (this.#starting ? await this.#starting : undefined);
    if (!child) return;
    void child.stdin.write(`${JSON.stringify({ id: randomUUID(), method: "close" })}\n`);
    await child.stdin.flush();
    await child.stdin.end();
    await child.exited;
  }
}

import type { Tool } from "@oh-my-pi/pi-ai";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

type Args = Record<string, unknown>;

interface ToolContract {
  readonly hostName: string;
  readonly declaration: Tool;
  readonly requiredHostArguments: readonly string[];
  decode(args: unknown, cwd: string): Args | Promise<Args>;
  encode(args: unknown, cwd: string): Promise<Args>;
}

function contract<S extends z.ZodType<Args>, H extends z.ZodType<Args>>(spec: {
  readonly hostName: string;
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly hostSchema: H;
  decode(args: z.output<S>, cwd: string): Args | Promise<Args>;
  encode(args: z.output<H>): Args;
}): ToolContract {
  const host = z.toJSONSchema(spec.hostSchema);
  return {
    hostName: spec.hostName,
    requiredHostArguments: host.required ?? [],
    declaration: {
      name: spec.name,
      description: spec.description,
      parameters: z.toJSONSchema(spec.schema, { target: "draft-2020-12" }),
    },
    decode(args, cwd) {
      const parsed = spec.schema.safeParse(args);
      if (!parsed.success) {
        throw new ConfigurationError(
          `Invalid ${spec.name} arguments: ${z.prettifyError(parsed.error)}`,
        );
      }
      return spec.decode(parsed.data, cwd);
    },
    async encode(args, cwd) {
      const native = spec.schema.parse(spec.encode(spec.hostSchema.parse(args)));
      // Replay only an operation that the same native route could admit.
      await spec.decode(native, cwd);
      return native;
    },
  };
}

const relativePath = z
  .string()
  .regex(/^[\p{L}\p{M}\p{N}_. /-]+$/u)
  .refine((path) =>
    path.split("/").every((part) => part && part === part.trim() && part !== "." && part !== ".."),
  );
const searchPath = z
  .string()
  .describe("An existing local path inside the workspace. Use . for the workspace root.")
  .refine(
    (path) =>
      path === "." ||
      path === "/" ||
      relativePath.safeParse(path.startsWith("/") ? path.slice(1) : path).success,
  );
const line = z.int().min(1);
const hostPath = z.strictObject({ path: z.string() });

function outsideWorkspace(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`);
}

async function resolveSearchPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (error instanceof Error && "code" in error)
      throw new ConfigurationError("Could not resolve the local search path");
    throw error;
  }
}

async function withinWorkspace(path: string, cwd: string): Promise<string> {
  const resolved = resolve(cwd, path);
  const root = await resolveSearchPath(cwd);
  if (outsideWorkspace(cwd, resolved) && outsideWorkspace(root, resolved)) {
    throw new ConfigurationError("Local searches must stay inside the workspace");
  }
  const target = await resolveSearchPath(resolved);
  if (outsideWorkspace(root, target)) {
    throw new ConfigurationError("Local searches must stay inside the workspace");
  }
  // Pass the checked target, not an alias. If the workspace's own prefix
  // cannot appear in OMP's path syntax, use its checked relative spelling.
  if (searchPath.safeParse(target).success) return target;
  const local = relative(root, target) || ".";
  if (searchPath.safeParse(local).success) return local;
  throw new ConfigurationError("The resolved path is not expressible as a local search path");
}

const read = contract({
  name: "read_file",
  hostName: "read",
  hostSchema: hostPath,
  description: "Read a local file. StartLine and EndLine are one-based and inclusive.",
  schema: z
    .strictObject({ Path: relativePath, StartLine: line.optional(), EndLine: line.optional() })
    .refine(({ StartLine, EndLine }) => EndLine === undefined || EndLine >= (StartLine ?? 1), {
      message: "EndLine must be at or after StartLine",
    }),
  async decode({ Path, StartLine, EndLine }, cwd) {
    const suffix =
      StartLine === undefined && EndLine === undefined ? "" : `:${StartLine ?? 1}-${EndLine ?? ""}`;
    const path = `${Path}:raw${suffix}`;
    // OMP prefers a literal file with this name over interpreting the selector.
    await lstat(resolve(cwd, path)).then(
      () => {
        throw new ConfigurationError(
          "A literal filename conflicts with the translated read selector",
        );
      },
      (error: unknown) => {
        if (!(error instanceof Error && "code" in error)) throw error;
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR")
          throw new ConfigurationError("Could not check for a literal read path");
      },
    );
    return { path };
  },
  encode({ path }) {
    const match = /^(?<Path>[^:]+):raw(?::(?<StartLine>[1-9]\d*)-(?<EndLine>[1-9]\d*)?)?$/.exec(
      path,
    );
    if (!match?.groups) throw new ConfigurationError("Cannot replay a non-local read selector");
    const { Path, StartLine, EndLine } = match.groups;
    return {
      Path,
      ...(StartLine === undefined ? {} : { StartLine: Number(StartLine) }),
      ...(EndLine === undefined ? {} : { EndLine: Number(EndLine) }),
    };
  },
});

const hostGrep = z.strictObject({
  path: z.string(),
  pattern: z.string(),
  case: z.boolean().optional(),
});
function literalRegex(query: string): string {
  return query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const grep = contract({
  name: "grep_search",
  hostName: "grep",
  hostSchema: hostGrep,
  description:
    "Search text inside the workspace. Supports single-line literal matches and returns OMP search output.",
  schema: z.strictObject({
    SearchPath: searchPath,
    Query: z
      .string()
      .refine((value) => value.trim() && !/[\r\n\\]/.test(value) && !value.includes("\0")),
    MatchPerLine: z.literal(true).describe("Must be true."),
    IsRegex: z.literal(false).describe("Must be false. Query is interpreted literally."),
    CaseInsensitive: z.boolean().optional(),
  }),
  async decode({ SearchPath, Query, CaseInsensitive }, cwd) {
    return {
      path: await withinWorkspace(SearchPath, cwd),
      pattern: literalRegex(Query),
      ...(CaseInsensitive === undefined ? {} : { case: !CaseInsensitive }),
    };
  },
  encode({ path, pattern, case: caseSensitive }) {
    const query = pattern.replace(/\\([.*+?^${}()|[\]\\])/g, "$1");
    if (literalRegex(query) !== pattern)
      throw new ConfigurationError("Cannot replay a non-literal grep pattern");
    return {
      SearchPath: path,
      Query: query,
      MatchPerLine: true,
      IsRegex: false,
      ...(caseSensitive === undefined ? {} : { CaseInsensitive: !caseSensitive }),
    };
  },
});

// The AGY find converter caps results at 50. Preserve that cap on OMP glob.
const findLimit = 50;
const hostGlob = z.strictObject({
  path: z.string(),
  limit: z.literal(findLimit),
  gitignore: z.literal(true),
  hidden: z.literal(false),
});
function nameGlob(pattern: string): string {
  return /[A-Z]/.test(pattern)
    ? pattern
    : pattern.replace(/[a-z]/g, (char) => `[${char}${char.toUpperCase()}]`);
}

const find = contract({
  name: "find_by_name",
  hostName: "glob",
  hostSchema: hostGlob,
  description:
    "Find files and directories recursively by filename glob inside the workspace. Supports ASCII names, * and ?, with smart case. Returns OMP path results.",
  schema: z.strictObject({
    SearchDirectory: searchPath,
    Pattern: z
      .string()
      .regex(/^[A-Za-z0-9_. *?-]+$/)
      .refine((pattern) => pattern.trim() === pattern && pattern !== "." && pattern !== ".."),
  }),
  async decode({ SearchDirectory, Pattern }, cwd) {
    return {
      path: join(await withinWorkspace(SearchDirectory, cwd), "**", nameGlob(Pattern)),
      limit: findLimit,
      gitignore: true,
      hidden: false,
    };
  },
  encode({ path }) {
    const match = /^(?:(?<directory>.*)\/)?\*\*\/(?<glob>[^/]+)$/.exec(path);
    if (!match?.groups) throw new ConfigurationError("Cannot replay a non-native find glob");
    const { directory, glob } = match.groups;
    if (glob === undefined) throw new ConfigurationError("Missing find glob");
    const pattern = glob.replace(/\[([a-z])[A-Z]\]/g, "$1");
    if (nameGlob(pattern) !== glob)
      throw new ConfigurationError("Cannot replay a non-native find glob");
    return { SearchDirectory: directory === undefined ? "." : directory || "/", Pattern: pattern };
  },
});

const hostWrite = z.strictObject({ path: z.string(), content: z.string() });
const write = contract({
  name: "write_file",
  hostName: "write",
  hostSchema: hostWrite,
  description:
    "Write complete file contents. Requires explicit Overwrite=true and does not append. Existing OMP write permissions still apply.",
  schema: z.strictObject({
    Path: relativePath,
    Content: z.string(),
    Overwrite: z.literal(true).describe("Must be true to explicitly allow overwriting."),
  }),
  decode({ Path, Content }) {
    return { path: Path, content: Content };
  },
  encode({ path, content }) {
    return { Path: path, Content: content, Overwrite: true };
  },
});

export const toolContracts: readonly ToolContract[] = [read, grep, find, write];

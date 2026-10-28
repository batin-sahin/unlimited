/**
 * File tools: read_file, write_file, edit_file, list_dir, glob, grep.
 * Every path is confined to the workspace — syntactically (.., absolute
 * paths) and through symlinks (realpath of the deepest existing ancestor).
 * Each tool catches its own errors and reports ToolResult, never throws.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import type { FileHandle } from "node:fs/promises";
import { registerTool } from "./index.js";
import type { ToolContext, ToolDef, ToolResult } from "./types.js";

// ---- limits ----
const BINARY_SNIFF = 8 * 1024; // NUL probe window
const READ_MAX_BYTES = 8_000_000; // refuse text reads beyond this
const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINES = 4000;
const READ_MAX_CHARS = 400_000; // char guard for pathological long lines
const LIST_CAP = 500;
const GLOB_CAP = 300;
const GREP_CAP = 200;
const GREP_MAX_FILE = 2_000_000;
const LINE_SNIPPET = 300;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// ---- arg coercion ----

function strArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function numArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(args[key]);
  return Number.isFinite(value) ? value : fallback;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Human path: workspace-relative when inside, absolute otherwise. */
function show(target: string, workspace: string): string {
  const rel = path.relative(workspace, target);
  return rel === "" ? "." : rel;
}

/** True when a workspace-relative path climbs above the root. */
function escapesRel(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

type SafePath = { ok: true; path: string } | { ok: false; error: string };

/**
 * Resolve `input` against the workspace and prove it cannot escape:
 * syntactically, or through symlinks (realpath the deepest existing
 * ancestor, rejoin the not-yet-existing suffix, re-check containment).
 */
async function resolveSafe(workspace: string, input: string): Promise<SafePath> {
  const value = input.trim();
  if (!value) return { ok: false, error: "path is required" };
  const resolved = path.resolve(workspace, value);
  if (escapesRel(path.relative(workspace, resolved))) {
    return { ok: false, error: `path escapes the workspace: ${value}` };
  }
  try {
    const wsReal = await fsp.realpath(workspace);
    let anc = resolved;
    for (;;) {
      const ok = await fsp.stat(anc).then(
        () => true,
        () => false,
      );
      if (ok) break;
      const parent = path.dirname(anc);
      if (parent === anc) break;
      anc = parent;
    }
    const realAnc = await fsp.realpath(anc);
    let candidate = path.join(realAnc, path.relative(anc, resolved));
    if (escapesRel(path.relative(wsReal, candidate))) {
      return { ok: false, error: `path escapes the workspace through a symlink: ${value}` };
    }
    // Keep working on (and displaying) the caller's spelling of the
    // workspace when it is itself behind a symlink (e.g. /tmp on macOS).
    if (wsReal !== workspace && candidate.startsWith(wsReal + path.sep)) {
      candidate = path.join(workspace, candidate.slice(wsReal.length + path.sep.length));
    } else if (candidate === wsReal) {
      candidate = workspace;
    }
    // A dangling symlink at the final component slips past realpath; refuse
    // it rather than write or read through it.
    const lst = await fsp.lstat(candidate).catch(() => null);
    if (lst?.isSymbolicLink()) {
      return { ok: false, error: `path is a broken symlink: ${value}` };
    }
    return { ok: true, path: candidate };
  } catch (err) {
    return { ok: false, error: `cannot resolve path: ${errMsg(err)}` };
  }
}

/**
 * Depth-first walk over regular files, skipping node_modules/.git.
 * `visit` returns false to stop the walk; the walk resolves to false
 * only when a visit asked to stop. Unreadable directories are skipped.
 */
async function walkTree(dir: string, visit: (abs: string) => Promise<boolean> | boolean): Promise<boolean> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return true;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (!(await walkTree(full, visit))) return false;
    } else if (!(await visit(full))) {
      return false;
    }
  }
  return true;
}

/** Glob → RegExp: `**` crosses directories, `*`/`?` stay within one. */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i++;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

// ---- read_file ----

const readFileTool: ToolDef = {
  name: "read_file",
  description:
    "Read a text file from the workspace. Returns numbered lines (line numbers are for reference — never include them when editing). Use offset/limit to page through large files (default limit 2000 lines). Binary files are reported, not dumped.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace." },
      offset: { type: "number", description: "1-based line to start reading from." },
      limit: {
        type: "number",
        description: `Maximum lines to return (default ${READ_DEFAULT_LINES}, hard cap ${READ_MAX_LINES}).`,
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    let handle: FileHandle | null = null;
    try {
      const safe = await resolveSafe(ctx.workspace, strArg(args, "path"));
      if (!safe.ok) return { ok: false, output: `Error: ${safe.error}` };
      const target = safe.path;
      try {
        handle = await fsp.open(target, "r");
      } catch (err) {
        return { ok: false, output: `Error: cannot open ${show(target, ctx.workspace)}: ${errMsg(err)}` };
      }
      const st = await handle.stat();
      if (st.isDirectory()) {
        return { ok: false, output: `Error: ${show(target, ctx.workspace)} is a directory; use list_dir.` };
      }
      const size = st.size;
      const sniff = Buffer.alloc(Math.min(size, BINARY_SNIFF));
      if (sniff.length) await handle.read(sniff, 0, sniff.length, 0);
      if (sniff.includes(0)) return { ok: true, output: `(binary file, ${size} bytes)` };
      if (size > READ_MAX_BYTES) {
        return {
          ok: false,
          output: `Error: file is ${size} bytes; too large to read in one call (limit ${READ_MAX_BYTES}).`,
        };
      }
      const buf = Buffer.alloc(size);
      if (size) await handle.read(buf, 0, size, 0);
      const lines = buf.toString("utf8").split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // trailing-newline artifact
      const total = lines.length;
      const offset = Math.max(1, Math.floor(numArg(args, "offset", 1)));
      const limit = Math.min(READ_MAX_LINES, Math.max(1, Math.floor(numArg(args, "limit", READ_DEFAULT_LINES))));
      const header = `${show(target, ctx.workspace)} · ${total} lines · ${size} bytes`;
      if (total === 0) return { ok: true, output: `${header}\n(empty file)` };
      if (offset > total) {
        return { ok: true, output: `${header}\n(offset ${offset} is past the last line; file has ${total})` };
      }
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      let body = selected.map((line, i) => `${String(offset + i).padStart(6)}  ${line}`).join("\n");
      if (body.length > READ_MAX_CHARS) {
        body = `${body.slice(0, READ_MAX_CHARS)}\n... (line output too large, truncated)`;
      }
      const more = total - (offset - 1 + selected.length);
      const footer = more > 0 ? `\n... (truncated, ${more} more lines)` : "";
      return { ok: true, output: `${header}\n${body}${footer}` };
    } catch (err) {
      return { ok: false, output: `Error: read_file failed: ${errMsg(err)}` };
    } finally {
      await handle?.close().catch(() => {});
    }
  },
};

// ---- write_file ----

const writeFileTool: ToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a file in the workspace with the given content. Parent directories are created automatically. Prefer edit_file for small changes to existing files.",
  risky: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const safe = await resolveSafe(ctx.workspace, strArg(args, "path"));
      if (!safe.ok) return { ok: false, output: `Error: ${safe.error}` };
      const content = args.content;
      if (typeof content !== "string") return { ok: false, output: "Error: content must be a string." };
      const target = safe.path;
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, content, "utf8");
      return {
        ok: true,
        output: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${show(target, ctx.workspace)}.`,
      };
    } catch (err) {
      return { ok: false, output: `Error: write_file failed: ${errMsg(err)}` };
    }
  },
};

// ---- edit_file ----

const editFileTool: ToolDef = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. oldText must match exactly (including whitespace) and must be unique unless replaceAll is true — include enough surrounding context to make it unique. Text only; not for binary files.",
  risky: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the workspace." },
      oldText: { type: "string", description: "Exact text to replace." },
      newText: { type: "string", description: "Replacement text (inserted literally, no $-patterns)." },
      replaceAll: { type: "boolean", description: "Replace every occurrence (default false)." },
    },
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const safe = await resolveSafe(ctx.workspace, strArg(args, "path"));
      if (!safe.ok) return { ok: false, output: `Error: ${safe.error}` };
      const target = safe.path;
      const oldText = strArg(args, "oldText");
      const newText = strArg(args, "newText");
      const replaceAll = args.replaceAll === true;
      if (!oldText) return { ok: false, output: "Error: oldText is empty." };
      let buf: Buffer;
      try {
        buf = await fsp.readFile(target);
      } catch (err) {
        return { ok: false, output: `Error: cannot read ${show(target, ctx.workspace)}: ${errMsg(err)}` };
      }
      if (buf.subarray(0, Math.min(buf.length, BINARY_SNIFF)).includes(0)) {
        return { ok: false, output: "Error: binary file; edit_file only works on text files." };
      }
      const text = buf.toString("utf8");
      const count = text.split(oldText).length - 1;
      if (count === 0) {
        return { ok: false, output: `Error: oldText not found in ${show(target, ctx.workspace)}.` };
      }
      if (count > 1 && !replaceAll) {
        return {
          ok: false,
          output: `Error: oldText occurs ${count} times in ${show(target, ctx.workspace)}; add more context or set replaceAll=true.`,
        };
      }
      // replacer-function form and split/join never expand $-patterns in
      // newText — the replacement is inserted literally.
      const next = replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
      await fsp.writeFile(target, next, "utf8");
      const replacements = replaceAll ? count : 1;
      return {
        ok: true,
        output: `Edited ${show(target, ctx.workspace)}: ${replacements} replacement${replacements === 1 ? "" : "s"}; file is now ${Buffer.byteLength(next, "utf8")} bytes.`,
      };
    } catch (err) {
      return { ok: false, output: `Error: edit_file failed: ${errMsg(err)}` };
    }
  },
};

// ---- list_dir ----

const listDirTool: ToolDef = {
  name: "list_dir",
  description:
    "List the entries of a directory in the workspace (default: the workspace root). Directories carry a trailing /. Use it to understand a project layout before reading files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, absolute or relative to the workspace (default: workspace root)." },
    },
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const safe = await resolveSafe(ctx.workspace, strArg(args, "path", "."));
      if (!safe.ok) return { ok: false, output: `Error: ${safe.error}` };
      const dir = safe.path;
      const st = await fsp.stat(dir).catch(() => null);
      if (!st) return { ok: false, output: `Error: not found: ${show(dir, ctx.workspace)}` };
      if (!st.isDirectory()) return { ok: false, output: `Error: ${show(dir, ctx.workspace)} is not a directory.` };
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      const lines: string[] = [];
      let listed = 0;
      let hidden = 0;
      for (const entry of entries) {
        const label = entry.name + (entry.isDirectory() ? "/" : "");
        if (listed >= LIST_CAP) {
          hidden++;
          continue;
        }
        if (SKIP_DIRS.has(entry.name)) {
          lines.push(`${label} (skipped)`);
          continue;
        }
        let sizeNote = "";
        if (!entry.isDirectory()) {
          const fst = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
          if (fst) sizeNote = ` (${fst.size}b)`;
        }
        lines.push(`${label}${sizeNote}`);
        listed++;
      }
      if (hidden > 0) lines.push(`... (${hidden} more)`);
      return { ok: true, output: `[${show(dir, ctx.workspace)}]\n${lines.join("\n") || "(empty)"}` };
    } catch (err) {
      return { ok: false, output: `Error: list_dir failed: ${errMsg(err)}` };
    }
  },
};

// ---- glob ----

const globTool: ToolDef = {
  name: "glob",
  description:
    "Find files in the workspace by glob pattern. Supports * and ? within a path segment and ** across segments (e.g. **/*.ts, src/**/*.test.ts). A pattern without / matches against file names at any depth. node_modules and .git are ignored.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the workspace." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const pattern = strArg(args, "pattern").trim();
      const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
      if (!norm) return { ok: false, output: "Error: pattern is empty." };
      const segs = norm.split("/");
      let base = ctx.workspace;
      let i = 0;
      for (; i < segs.length - 1 && !/[*?]/.test(segs[i]); i++) base = path.join(base, segs[i]);
      const re = globToRegExp(segs.slice(i).join("/"));
      const byBasename = !norm.includes("/");
      // Walk only the literal directory prefix of the pattern (src/ in src/**/*.ts).
      const baseOk = await fsp.stat(base).then(
        () => true,
        () => false,
      );
      const results: string[] = [];
      let capped = false;
      if (baseOk) {
        await walkTree(base, (abs) => {
          const relBase = path.relative(base, abs).split(path.sep).join("/");
          const hit = byBasename ? re.test(path.posix.basename(relBase)) : re.test(relBase);
          if (!hit) return true;
          if (results.length >= GLOB_CAP) {
            capped = true;
            return false;
          }
          results.push(path.relative(ctx.workspace, abs).split(path.sep).join("/"));
          return true;
        });
      }
      if (results.length === 0) return { ok: true, output: `No matches for '${pattern}'.` };
      results.sort();
      const note = capped ? `\n... (capped at ${GLOB_CAP} results)` : "";
      return { ok: true, output: `${results.join("\n")}${note}` };
    } catch (err) {
      return { ok: false, output: `Error: glob failed: ${errMsg(err)}` };
    }
  },
};

// ---- grep ----

const grepTool: ToolDef = {
  name: "grep",
  description:
    "Search file contents under a path in the workspace (default: the whole workspace) for a literal substring — not a regex. Prints path:line: text per match. Binary files, node_modules and .git are skipped. Use ignoreCase for case-insensitive matching.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Literal text to find." },
      path: { type: "string", description: "File or directory to search, absolute or relative to the workspace (default: workspace root)." },
      ignoreCase: { type: "boolean", description: "Case-insensitive match (default false)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const pattern = strArg(args, "pattern");
      if (!pattern.trim()) return { ok: false, output: "Error: pattern is empty." };
      const ignoreCase = args.ignoreCase === true;
      const needle = ignoreCase ? pattern.toLowerCase() : pattern;
      const safe = await resolveSafe(ctx.workspace, strArg(args, "path", "."));
      if (!safe.ok) return { ok: false, output: `Error: ${safe.error}` };
      const root = safe.path;
      const st = await fsp.stat(root).catch(() => null);
      if (!st) return { ok: false, output: `Error: not found: ${show(root, ctx.workspace)}` };
      const matches: string[] = [];
      const scanFile = async (abs: string): Promise<boolean> => {
        try {
          const fst = await fsp.stat(abs);
          if (fst.size > GREP_MAX_FILE) return true;
          const buf = await fsp.readFile(abs);
          if (buf.subarray(0, Math.min(buf.length, BINARY_SNIFF)).includes(0)) return true; // binary
          const lines = buf.toString("utf8").split("\n");
          const rel = path.relative(ctx.workspace, abs).split(path.sep).join("/");
          for (let i = 0; i < lines.length; i++) {
            const hay = ignoreCase ? lines[i].toLowerCase() : lines[i];
            if (!hay.includes(needle)) continue;
            const snippet = lines[i].trim();
            matches.push(`${rel}:${i + 1}: ${snippet.slice(0, LINE_SNIPPET)}${snippet.length > LINE_SNIPPET ? "…" : ""}`);
            if (matches.length >= GREP_CAP) return false;
          }
        } catch {
          // unreadable file — skip it
        }
        return true;
      };
      let stopped = false;
      if (st.isFile()) {
        stopped = !(await scanFile(root));
      } else if (st.isDirectory()) {
        stopped = !(await walkTree(root, scanFile));
      } else {
        return { ok: false, output: `Error: not a file or directory: ${show(root, ctx.workspace)}` };
      }
      if (matches.length === 0) return { ok: true, output: `No matches for '${pattern}'.` };
      const note = stopped ? `\n... (stopped at ${GREP_CAP} matches)` : "";
      return { ok: true, output: `${matches.join("\n")}${note}` };
    } catch (err) {
      return { ok: false, output: `Error: grep failed: ${errMsg(err)}` };
    }
  },
};

// ---- registration (module scope) ----

registerTool(readFileTool);
registerTool(writeFileTool);
registerTool(editFileTool);
registerTool(listDirTool);
registerTool(globTool);
registerTool(grepTool);

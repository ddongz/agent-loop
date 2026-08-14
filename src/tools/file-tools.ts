import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import { ActionSchema, type Action, type Observation } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import { isSensitiveWorkspacePath, normalizeWorkspaceRelativePath, resolveWorkspacePath } from "../governance/path-policy.js";
import { decodeUtf8Prefix, identityRedactor, ObservationTimer, type Redactor, type Tool } from "./types.js";

const MiB = 1_048_576;
const outputLimit = 65_536;
const sensitiveConstraint = ["EXCLUDE_SENSITIVE_PATHS_RECURSIVELY"] as const;

export interface FileToolsOptions {
  workspaceRoot: string;
  redact?: Redactor;
  beforeMutation?: (target: string) => void | Promise<void>;
}

export function createFileTools(options: FileToolsOptions): Tool[] {
  const redact = options.redact ?? identityRedactor;
  return [
    tool("read_file", [], (action, signal) => readFileAction(options.workspaceRoot, action, signal), redact),
    tool("list_files", sensitiveConstraint, (action, signal) => listFilesAction(options.workspaceRoot, action, signal), redact),
    tool("search_files", sensitiveConstraint, (action, signal) => searchFilesAction(options.workspaceRoot, action, signal), redact),
    tool("create_file", [], (action, signal) => createFileAction(options, action, signal), redact),
    tool("apply_patch", [], (action, signal) => applyPatchAction(options, action, signal), redact),
  ];
}

function tool<T extends Action["type"]>(
  type: T,
  constraints: readonly "EXCLUDE_SENSITIVE_PATHS_RECURSIVELY"[],
  operation: (action: Extract<Action, { type: T }>, signal: AbortSignal) => Promise<{ output: string; truncated?: boolean }>,
  redact: Redactor,
): Tool {
  return {
    type,
    schema: ActionSchema.refine((action) => action.type === type, `Expected ${type} action.`),
    constraints,
    async execute(action, signal): Promise<Observation> {
      const timer = new ObservationTimer(action, redact);
      if (action.type !== type) {
        return timer.fail(new SentinelError({ code: "INVALID_ACTION", message: `Action type does not match ${type}.` }));
      }
      try {
        const result = await operation(action as Extract<Action, { type: T }>, signal);
        return timer.succeed(result.output, result.truncated ?? false);
      } catch (error) {
        return timer.fail(error);
      }
    },
  };
}

async function readFileAction(
  root: string,
  action: Extract<Action, { type: "read_file" }>,
  signal: AbortSignal,
): Promise<{ output: string; truncated: boolean }> {
  assertNotAborted(signal);
  const target = await resolveWorkspacePath(root, action.path);
  const metadata = await stat(target);
  if (!metadata.isFile()) throw invalidInput("read_file requires a regular file.");
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.alloc(Math.min(action.maxBytes + 1, MiB + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > action.maxBytes;
    const bounded = buffer.subarray(0, Math.min(bytesRead, action.maxBytes));
    if (bounded.includes(0)) throw invalidInput("File content contains NUL bytes.");
    return { output: decodeUtf8Prefix(bounded, truncated), truncated };
  } finally {
    await handle.close();
  }
}

async function listFilesAction(
  root: string,
  action: Extract<Action, { type: "list_files" }>,
  signal: AbortSignal,
): Promise<{ output: string; truncated: boolean }> {
  const realRoot = await realpath(root);
  const start = action.path === undefined ? realRoot : await resolveWorkspacePath(realRoot, action.path);
  const startMetadata = await lstat(start);
  const entries: string[] = [];
  let hitEntryLimit = false;

  if (startMetadata.isFile()) {
    entries.push(toRelative(realRoot, start));
  } else if (!startMetadata.isDirectory()) {
    throw invalidInput("list_files requires a file or directory.");
  } else {
    await walk(start, 0);
  }

  const bounded = boundText(entries.join("\n"), outputLimit);
  return { output: bounded.output, truncated: hitEntryLimit || bounded.truncated };

  async function walk(directory: string, depth: number): Promise<void> {
    assertNotAborted(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = toRelative(realRoot, absolute);
      if (isSensitiveWorkspacePath(path)) continue;
      if (entries.length >= action.maxEntries) {
        hitEntryLimit = true;
        return;
      }
      entries.push(child.isDirectory() ? `${path}/` : child.isSymbolicLink() ? `${path}@` : path);
      if (child.isDirectory() && depth < action.maxDepth) await walk(absolute, depth + 1);
      if (hitEntryLimit) return;
    }
  }
}

async function searchFilesAction(
  root: string,
  action: Extract<Action, { type: "search_files" }>,
  signal: AbortSignal,
): Promise<{ output: string; truncated: boolean }> {
  const realRoot = await realpath(root);
  const start = action.path === undefined ? realRoot : await resolveWorkspacePath(realRoot, action.path);
  const metadata = await lstat(start);
  const matches: string[] = [];
  let hitResultLimit = false;
  const glob = action.glob === undefined ? null : globPattern(action.glob);

  if (metadata.isFile()) await searchOne(start);
  else if (metadata.isDirectory()) await walk(start);
  else throw invalidInput("search_files requires a file or directory.");

  const bounded = boundText(matches.join("\n"), outputLimit);
  return { output: bounded.output, truncated: hitResultLimit || bounded.truncated };

  async function walk(directory: string): Promise<void> {
    assertNotAborted(signal);
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const absolute = resolve(directory, child.name);
      const path = toRelative(realRoot, absolute);
      if (isSensitiveWorkspacePath(path) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) await walk(absolute);
      else if (child.isFile()) await searchOne(absolute);
      if (hitResultLimit) return;
    }
  }

  async function searchOne(path: string): Promise<void> {
    assertNotAborted(signal);
    const relativePath = toRelative(realRoot, path);
    if (isSensitiveWorkspacePath(relativePath) || (glob !== null && !glob.test(relativePath))) return;
    const metadata = await stat(path);
    if (metadata.size > MiB) return;
    const content = await readFile(path);
    if (content.includes(0)) return;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      return;
    }
    const lines = text.replaceAll("\r\n", "\n").split("\n");
    for (const [index, line] of lines.entries()) {
      let offset = 0;
      while (offset <= line.length) {
        const column = line.indexOf(action.query, offset);
        if (column < 0) break;
        if (matches.length >= action.maxResults) {
          hitResultLimit = true;
          return;
        }
        matches.push(`${relativePath}:${index + 1}:${column + 1}:${line}`);
        offset = column + Math.max(1, action.query.length);
      }
    }
  }
}

async function createFileAction(
  options: FileToolsOptions,
  action: Extract<Action, { type: "create_file" }>,
  signal: AbortSignal,
): Promise<{ output: string }> {
  assertWritableText(action.content, "File content");
  const content = Buffer.from(action.content, "utf8");
  if (content.byteLength > MiB) throw invalidInput("File content exceeds the 1 MiB byte limit.");
  const target = await resolveWorkspacePath(options.workspaceRoot, action.path);
  if (await pathExists(target)) throw invalidInput("create_file will not overwrite an existing path.");
  const parent = dirname(target);
  if (!(await stat(parent)).isDirectory()) throw invalidInput("The destination parent is not a directory.");
  const temporary = await workspaceTemporaryPath(options.workspaceRoot, target);
  await writeFile(temporary, content, { flag: "wx" });
  try {
    assertNotAborted(signal);
    await options.beforeMutation?.(target);
    const revalidated = await resolveWorkspacePath(options.workspaceRoot, action.path);
    if (!samePath(target, revalidated) || await pathExists(revalidated)) {
      throw new SentinelError({ code: "PATH_ESCAPE", message: "The destination changed before file creation." });
    }
    await link(temporary, revalidated);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { output: `created ${normalizeWorkspaceRelativePath(action.path)}` };
}

async function applyPatchAction(
  options: FileToolsOptions,
  action: Extract<Action, { type: "apply_patch" }>,
  signal: AbortSignal,
): Promise<{ output: string }> {
  assertWritableText(action.patch, "Patch");
  if (Buffer.byteLength(action.patch, "utf8") > MiB) throw invalidInput("Patch exceeds the 1 MiB byte limit.");
  const target = await resolveWorkspacePath(options.workspaceRoot, action.path);
  const metadata = await stat(target);
  if (!metadata.isFile()) throw invalidInput("apply_patch requires a regular file.");
  const original = await readFile(target);
  assertText(original, "Patched file");
  const updated = applyUnifiedDiff(original, action.path, action.patch);
  if (updated.byteLength > MiB) throw invalidInput("Patched file exceeds the 1 MiB byte limit.");
  const temporary = await workspaceTemporaryPath(options.workspaceRoot, target);
  await writeFile(temporary, updated, { flag: "wx" });
  try {
    assertNotAborted(signal);
    await options.beforeMutation?.(target);
    const revalidated = await resolveWorkspacePath(options.workspaceRoot, action.path);
    if (!samePath(target, revalidated)) {
      throw new SentinelError({ code: "PATH_ESCAPE", message: "The patch destination changed before replacement." });
    }
    const current = await readFile(revalidated);
    if (!current.equals(original)) throw patchConflict("The file changed while the patch was being prepared.");
    await rename(temporary, revalidated);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return { output: `patched ${normalizeWorkspaceRelativePath(action.path)}` };
}

type LineEnding = "" | "\n" | "\r\n";

interface SourceLine {
  content: string;
  ending: LineEnding;
  bytes: Buffer;
}

interface DiffLine {
  kind: "context" | "remove" | "add";
  content: string;
  oldNoNewline: boolean;
  newNoNewline: boolean;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

function applyUnifiedDiff(original: Buffer, path: string, patch: string): Buffer {
  const source = parseSourceLines(original);
  const hunks = parseHunks(path, patch);
  const output: SourceLine[] = [];
  let sourceCursor = 0;
  let precedingHunkIndex: number | null = null;

  for (const hunk of hunks) {
    const oldIndex = coordinateIndex(hunk.oldStart, hunk.oldCount, "old");
    if (oldIndex < sourceCursor || oldIndex + hunk.oldCount > source.length) {
      throw patchConflict("Patch hunks are out of order, overlap, or exceed the original file.");
    }
    if (hunk.oldCount === 0 && precedingHunkIndex === oldIndex) {
      throw patchConflict("Multiple insertion hunks use an ambiguous original coordinate.");
    }

    output.push(...source.slice(sourceCursor, oldIndex));
    const expectedNewStart = hunk.newCount === 0 ? output.length : output.length + 1;
    if (hunk.newStart !== expectedNewStart) {
      throw patchConflict("Patch new-file coordinates are inconsistent with preceding hunks.");
    }

    const oldSequence = hunk.lines
      .filter(({ kind }) => kind !== "add")
      .map(({ content }) => content);
    if (oldSequence.length > 0 && countOccurrences(source, oldSequence) > 1) {
      throw patchConflict("Patch context is ambiguous.");
    }

    const oldRegion = source.slice(oldIndex, oldIndex + hunk.oldCount);
    const removedEndings: LineEnding[] = [];
    let oldOffset = 0;
    for (const line of hunk.lines) {
      if (line.kind === "add") continue;
      if (line.kind === "remove") removedEndings.push(source[oldIndex + oldOffset]?.ending ?? "");
      oldOffset += 1;
    }
    let consumed = 0;
    let added = 0;
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        const ending = line.newNoNewline ? "" : additionEnding(source, oldRegion, removedEndings, oldIndex, added);
        output.push(makeLine(line.content, ending));
        added += 1;
        continue;
      }

      const originalLine = source[oldIndex + consumed];
      if (originalLine === undefined || originalLine.content !== line.content) {
        throw patchConflict("Patch context does not match the original file coordinate.");
      }
      if (line.oldNoNewline !== (originalLine.ending === "")) {
        throw patchConflict("Patch old-side EOF newline marker does not match the original bytes.");
      }
      if (line.kind === "context") {
        if (line.newNoNewline !== (originalLine.ending === "")) {
          throw patchConflict("Patch context has inconsistent EOF newline markers.");
        }
        output.push(originalLine);
      }
      consumed += 1;
    }
    if (consumed !== hunk.oldCount || outputLineCount(hunk.lines) !== hunk.newCount) {
      throw patchConflict("Patch hunk counts do not match its operations.");
    }
    sourceCursor = oldIndex + hunk.oldCount;
    precedingHunkIndex = oldIndex;
  }

  output.push(...source.slice(sourceCursor));
  if (output.slice(0, -1).some(({ ending }) => ending === "")) {
    throw patchConflict("A no-newline marker can describe only the final output line.");
  }
  return Buffer.concat(output.map(({ bytes }) => bytes));
}

function parseHunks(path: string, patch: string): Hunk[] {
  const patchLines = patch.replaceAll("\r\n", "\n").split("\n");
  if (patchLines.at(-1) === "") patchLines.pop();
  if (patchLines[0] !== `--- a/${path}` || patchLines[1] !== `+++ b/${path}`) {
    throw patchConflict("Patch headers do not match the requested path.");
  }
  if (patchLines.slice(2).some((line) => line.startsWith("--- ") || line.startsWith("+++ "))) {
    throw patchConflict("A patch action can modify only one file.");
  }

  const hunks: Hunk[] = [];
  for (let index = 2; index < patchLines.length;) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(patchLines[index] ?? "");
    if (header === null) throw patchConflict("Patch contains malformed hunk metadata.");
    const oldStart = parseCoordinate(header[1]);
    const oldCount = parseCoordinate(header[2] ?? "1");
    const newStart = parseCoordinate(header[3]);
    const newCount = parseCoordinate(header[4] ?? "1");
    coordinateIndex(oldStart, oldCount, "old");
    coordinateIndex(newStart, newCount, "new");
    index += 1;
    const lines: DiffLine[] = [];
    while (index < patchLines.length && !patchLines[index]?.startsWith("@@ ")) {
      const raw = patchLines[index] ?? "";
      if (raw === "\\ No newline at end of file") {
        const previous = lines.at(-1);
        if (previous === undefined) throw patchConflict("EOF marker has no preceding diff line.");
        if (previous.kind !== "add") {
          if (previous.oldNoNewline) throw patchConflict("Patch repeats an old-side EOF marker.");
          previous.oldNoNewline = true;
        }
        if (previous.kind !== "remove") {
          if (previous.newNoNewline) throw patchConflict("Patch repeats a new-side EOF marker.");
          previous.newNoNewline = true;
        }
        index += 1;
        continue;
      }
      const prefix = raw[0];
      const content = raw.slice(1);
      const kind = prefix === " " ? "context" : prefix === "-" ? "remove" : prefix === "+" ? "add" : null;
      if (kind === null) throw patchConflict("Patch contains an invalid hunk line.");
      lines.push({ kind, content, oldNoNewline: false, newNoNewline: false });
      index += 1;
    }
    const actualOld = lines.filter(({ kind }) => kind !== "add").length;
    const actualNew = outputLineCount(lines);
    if (actualOld !== oldCount || actualNew !== newCount) {
      throw patchConflict("Patch hunk counts do not match its header.");
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }
  if (hunks.length === 0) throw patchConflict("Patch contains no hunks.");
  return hunks;
}

function parseSourceLines(original: Buffer): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < original.length; index += 1) {
    if (original[index] !== 0x0a) continue;
    const crlf = index > start && original[index - 1] === 0x0d;
    const contentEnd = crlf ? index - 1 : index;
    const contentBytes = original.subarray(start, contentEnd);
    lines.push({
      content: decodeSourceContent(contentBytes),
      ending: crlf ? "\r\n" : "\n",
      bytes: original.subarray(start, index + 1),
    });
    start = index + 1;
  }
  if (start < original.length) {
    const contentBytes = original.subarray(start);
    lines.push({ content: decodeSourceContent(contentBytes), ending: "", bytes: contentBytes });
  }
  return lines;
}

function decodeSourceContent(content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  } catch (error) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "Patched file is not valid UTF-8 text.", cause: error });
  }
}

function coordinateIndex(start: number, count: number, side: "old" | "new"): number {
  if (count === 0) return start;
  if (start < 1) throw patchConflict(`Patch ${side}-side non-empty range must start at line 1 or later.`);
  return start - 1;
}

function parseCoordinate(value: string | undefined): number {
  const coordinate = Number(value);
  if (!Number.isSafeInteger(coordinate) || coordinate < 0) throw patchConflict("Patch coordinates must be safe non-negative integers.");
  return coordinate;
}

function countOccurrences(source: readonly SourceLine[], sequence: readonly string[]): number {
  let count = 0;
  for (let index = 0; index <= source.length - sequence.length; index += 1) {
    if (sequence.every((content, offset) => source[index + offset]?.content === content)) count += 1;
  }
  return count;
}

function outputLineCount(lines: readonly DiffLine[]): number {
  return lines.filter(({ kind }) => kind !== "remove").length;
}

function additionEnding(
  source: readonly SourceLine[],
  oldRegion: readonly SourceLine[],
  removedEndings: readonly LineEnding[],
  oldIndex: number,
  addedIndex: number,
): Exclude<LineEnding, ""> {
  const replaced = removedEndings[addedIndex];
  if (replaced === "\n" || replaced === "\r\n") return replaced;
  const candidates = [
    source[oldIndex - 1]?.ending,
    ...oldRegion.map(({ ending }) => ending),
    source[oldIndex + oldRegion.length]?.ending,
  ];
  return candidates.find((ending): ending is "\n" | "\r\n" => ending === "\n" || ending === "\r\n") ?? "\n";
}

function makeLine(content: string, ending: LineEnding): SourceLine {
  return { content, ending, bytes: Buffer.from(`${content}${ending}`, "utf8") };
}

function assertText(content: Buffer, label: string): void {
  if (content.includes(0)) throw invalidInput(`${label} contains NUL bytes.`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new SentinelError({ code: "INVALID_INPUT", message: `${label} is not valid UTF-8 text.`, cause: error });
  }
}

function assertWritableText(content: string, label: string): void {
  if (content.includes("\0")) throw invalidInput(`${label} contains a NUL character.`);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new SentinelError({ code: "TOOL_TIMEOUT", message: "Tool execution was aborted." });
}

function boundText(value: string, maxBytes: number): { output: string; truncated: boolean } {
  const content = Buffer.from(value, "utf8");
  if (content.byteLength <= maxBytes) return { output: value, truncated: false };
  return { output: decodeUtf8Prefix(content.subarray(0, maxBytes), true), truncated: true };
}

function globPattern(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] as string;
    if (character === "*" && glob[index + 1] === "*" && glob[index + 2] === "/") {
      pattern += "(?:.*/)?";
      index += 2;
    }
    else if (character === "*" && glob[index + 1] === "*") { pattern += ".*"; index += 1; }
    else if (character === "*") pattern += "[^/]*";
    else if (character === "?") pattern += "[^/]";
    else pattern += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`, process.platform === "win32" ? "i" : "");
}

function toRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function workspaceTemporaryPath(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root);
  return resolve(realRoot, `.${basename(target)}.${randomUUID()}.tmp`);
}

function invalidInput(message: string): SentinelError {
  return new SentinelError({ code: "INVALID_INPUT", message });
}

function patchConflict(message: string): SentinelError {
  return new SentinelError({ code: "PATCH_CONFLICT", message });
}

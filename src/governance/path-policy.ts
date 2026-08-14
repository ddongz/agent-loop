import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

import { SentinelError } from "../domain/error.js";

const sensitiveSegments = new Set([".git", ".sentinelloop"]);

export function normalizeWorkspaceRelativePath(input: string): string {
  if (input.length === 0 || input.includes("\0") || isAbsolute(input) || win32.isAbsolute(input)) {
    throw pathEscape(input, "Path must be a non-empty repository-relative path.");
  }

  const slashPath = input.replaceAll("\\", "/");
  const normalized = posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw pathEscape(input, "Path traversal is outside the workspace.");
  }

  const segments = normalized.split("/");
  const first = segments[0]?.toLocaleLowerCase("en-US");
  if (
    first === undefined
    || sensitiveSegments.has(first)
    || first === ".env"
    || first.startsWith(".env.")
  ) {
    throw new SentinelError({
      code: "POLICY_DENIED",
      message: "Sensitive internal paths are not available to agent actions.",
      detail: { path: normalized },
    });
  }

  return normalized;
}

export async function resolveWorkspacePath(root: string, input: string): Promise<string> {
  const normalized = normalizeWorkspaceRelativePath(input);
  const realRoot = await realpath(root);
  const lexicalTarget = resolve(realRoot, ...normalized.split("/"));
  assertContained(realRoot, lexicalTarget, input);

  let ancestor = lexicalTarget;
  const suffix: string[] = [];
  while (!(await exists(ancestor))) {
    const parent = resolve(ancestor, "..");
    if (parent === ancestor) throw pathEscape(input, "No existing workspace ancestor was found.");
    suffix.unshift(relative(parent, ancestor));
    ancestor = parent;
  }

  const realAncestor = await realpath(ancestor);
  assertContained(realRoot, realAncestor, input);
  const target = suffix.length === 0 ? realAncestor : join(realAncestor, ...suffix);
  assertContained(realRoot, target, input);
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function assertContained(root: string, candidate: string, input: string): void {
  const relativePath = relative(root, candidate);
  const escaped = relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath);
  if (escaped) throw pathEscape(input, "Resolved path is outside the real workspace root.");
}

function pathEscape(path: string, message: string): SentinelError {
  return new SentinelError({ code: "PATH_ESCAPE", message, detail: { path } });
}

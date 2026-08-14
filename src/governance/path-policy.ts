import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";

import { SentinelError } from "../domain/error.js";

const sensitiveSegments = new Set([".git", ".sentinelloop"]);

export function isSensitiveWorkspacePath(input: string): boolean {
  const normalized = posix.normalize(input.replaceAll("\\", "/"));
  return normalized.split("/").some((segment) => {
    const comparison = segment.toLocaleLowerCase("en-US");
    return sensitiveSegments.has(comparison)
      || comparison === ".env"
      || comparison.startsWith(".env.");
  });
}

export function normalizeWorkspaceRelativePath(input: string): string {
  if (input.length === 0 || input.length > 4_096 || input.includes("\0") || isAbsolute(input) || win32.isAbsolute(input)) {
    throw pathEscape(input, "Path must be a non-empty repository-relative path.");
  }

  const slashPath = input.replaceAll("\\", "/");
  const normalized = posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw pathEscape(input, "Path traversal is outside the workspace.");
  }

  if (isSensitiveWorkspacePath(normalized)) {
    throw sensitivePath(normalized);
  }

  return normalized;
}

export async function resolveWorkspacePath(root: string, input: string): Promise<string> {
  const normalized = normalizeWorkspaceRelativePath(input);
  const realRoot = await realpathOrEscape(root, input);
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

  const realAncestor = await realpathOrEscape(ancestor, input);
  assertContained(realRoot, realAncestor, input);
  const target = suffix.length === 0 ? realAncestor : join(realAncestor, ...suffix);
  assertContained(realRoot, target, input);
  const resolvedRelativePath = relative(realRoot, target).replaceAll(sep, "/");
  if (isSensitiveWorkspacePath(resolvedRelativePath)) throw sensitivePath(input);
  return target;
}

async function realpathOrEscape(path: string, input: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isUnresolvableLinkError(error)) {
      throw pathEscape(input, "A workspace path ancestor is a dangling or unresolvable link.");
    }
    throw error;
  }
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

function isUnresolvableLinkError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP");
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

function sensitivePath(path: string): SentinelError {
  return new SentinelError({
    code: "POLICY_DENIED",
    message: "Sensitive internal paths are not available to agent actions.",
    detail: { path },
  });
}

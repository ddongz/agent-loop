import { spawn } from "node:child_process";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { join, normalize } from "node:path";

import { SentinelError } from "../domain/error.js";
import { discoverPackageManager, type PackageManager } from "./package-manager.js";
import {
  discoverValidationPlan,
  type ValidationOverrides,
  type ValidationPlan,
} from "./validation-discovery.js";

export interface RepositoryProfile {
  root: string;
  packageManager: PackageManager;
  validationPlan: ValidationPlan;
}

export interface RepositoryPrecheckOptions {
  nodeVersion?: string;
  validationOverrides?: ValidationOverrides;
}

export async function precheckRepository(
  root: string,
  options: RepositoryPrecheckOptions = {},
): Promise<RepositoryProfile> {
  const resolvedRoot = await resolveRoot(root);
  await requirePath(join(resolvedRoot, ".git"), "NOT_GIT_REPOSITORY", "Repository root must contain .git.");
  await requirePath(join(resolvedRoot, "package.json"), "PACKAGE_JSON_MISSING", "Repository root must contain package.json.");
  requireSupportedNode(options.nodeVersion ?? process.versions.node);

  const repositoryTopLevel = await runGit(resolvedRoot, ["rev-parse", "--show-toplevel"]);
  if (normalizeForComparison(await realpath(repositoryTopLevel.trim())) !== normalizeForComparison(resolvedRoot)) {
    throw new SentinelError({ code: "NOT_GIT_REPOSITORY", message: "The supplied path is not the Git repository root." });
  }

  const branch = await runGit(resolvedRoot, ["branch", "--show-current"]);
  if (branch.trim().length === 0) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "The repository must be on an auditable branch." });
  }

  const status = await runGit(resolvedRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.length > 0) {
    throw new SentinelError({ code: "DIRTY_WORKTREE", message: "Repository worktree must be clean before starting a task." });
  }

  const files = await readdir(resolvedRoot);
  const packageManager = discoverPackageManager(files);
  const packageJson = await readPackageJson(join(resolvedRoot, "package.json"));
  const validationPlan = discoverValidationPlan(packageJson, options.validationOverrides, packageManager);

  return { root: resolvedRoot, packageManager, validationPlan };
}

async function resolveRoot(root: string): Promise<string> {
  if (root.trim().length === 0) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "Repository root cannot be empty." });
  }
  try {
    return await realpath(root);
  } catch (cause) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "Repository root cannot be resolved.", cause });
  }
}

async function requirePath(path: string, code: "NOT_GIT_REPOSITORY" | "PACKAGE_JSON_MISSING", message: string): Promise<void> {
  try {
    await access(path);
  } catch (cause) {
    throw new SentinelError({ code, message, cause });
  }
}

function requireSupportedNode(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:$|-)/.exec(version);
  if (match === null) {
    throw new SentinelError({ code: "UNSUPPORTED_NODE_VERSION", message: `Cannot parse Node.js version: ${version}.` });
  }
  const current = match.slice(1).map(Number);
  const minimum = [22, 12, 0];
  const firstDifference = current.findIndex((part, index) => part !== minimum[index]);
  const supported = firstDifference === -1 || current[firstDifference]! > minimum[firstDifference]!;
  if (!supported) {
    throw new SentinelError({ code: "UNSUPPORTED_NODE_VERSION", message: `Node.js >=22.12.0 is required; found ${version}.` });
  }
}

async function readPackageJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "package.json is not valid JSON.", cause });
  }
}

async function runGit(root: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (cause) => reject(new SentinelError({ code: "NOT_GIT_REPOSITORY", message: "Git could not inspect the repository.", cause })));
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new SentinelError({ code: "NOT_GIT_REPOSITORY", message: "Git could not inspect the repository.", detail: { stderr: stderr.trim() } }));
    });
  });
}

function normalizeForComparison(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

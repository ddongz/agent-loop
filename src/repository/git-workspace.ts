import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SentinelError } from "../domain/error.js";
import { isSensitiveWorkspacePath } from "../governance/path-policy.js";

export class GitWorkspaceInspector {
  async currentDiff(root: string): Promise<string> {
    const tracked = await runGit(root, ["diff", "--no-ext-diff", "--binary", "--", "."]);
    const untracked = splitZero(await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
    const additions = await Promise.all(untracked.toSorted().map(async (path) => {
      const content = await readFile(join(root, ...path.split("/")));
      if (content.includes(0)) {
        return `Binary untracked file ${path} sha256 ${createHash("sha256").update(content).digest("hex")}`;
      }
      return untrackedDiff(path, new TextDecoder("utf-8", { fatal: true }).decode(content));
    }));
    return [tracked.trimEnd(), ...additions].filter(Boolean).join("\n");
  }

  async listTestPaths(root: string): Promise<string[]> {
    const paths = splitZero(await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
    const tests = await Promise.all(paths.filter(isTestPath).map(async (path) => {
      try {
        return (await lstat(join(root, ...path.split("/")))).isFile() ? path : null;
      } catch {
        return null;
      }
    }));
    return [...new Set(tests.filter((path): path is string => path !== null))]
      .sort((left, right) => left.localeCompare(right, "en"));
  }

  async verifyPolicy(root: string): Promise<boolean> {
    const paths = splitZero(await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]));
    return !paths.some(isSensitiveWorkspacePath);
  }
}

function isTestPath(path: string): boolean {
  const lower = path.toLocaleLowerCase("en-US");
  return lower.startsWith("tests/")
    || lower.includes("/__tests__/")
    || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(lower);
}

function splitZero(value: string): string[] {
  return value.split("\0").filter((path) => path.length > 0);
}

function untrackedDiff(path: string, content: string): string {
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const hasFinalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hasFinalNewline) lines.pop();
  const body = lines.map((line) => `+${line}`);
  if (!hasFinalNewline) body.push("\\ No newline at end of file");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...body,
  ].join("\n");
}

async function runGit(root: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (cause) => reject(new SentinelError({
      code: "VALIDATION_INFRASTRUCTURE",
      message: "Git could not inspect the working tree.",
      cause,
    })));
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new SentinelError({
        code: "VALIDATION_INFRASTRUCTURE",
        message: "Git could not inspect the working tree.",
        detail: { stderr: stderr.trim() },
      }));
    });
  });
}

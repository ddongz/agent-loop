import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const outputDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(outputDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function buildEntry(outputDirectory: string): Promise<void> {
  const root = process.cwd();
  const build = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", outputDirectory], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(build.status, build.stderr).toBe(0);
}

function runEntry(entryPath: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [entryPath, "--help"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
}

describe("built CLI entry", () => {
  it("prints help and exposes the five top-level commands", async () => {
    const root = process.cwd();
    const outputDirectory = await mkdtemp(join(root, ".entry-smoke-"));
    outputDirectories.push(outputDirectory);
    await buildEntry(outputDirectory);

    const result = runEntry(join(outputDirectory, "index.js"));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: sentinelloop");
    for (const command of ["auth", "run", "resume", "status", "report"]) {
      expect(result.stdout).toContain(command);
    }
  }, 15_000);

  it("runs the CLI when the entry path is reached through a link", async () => {
    const root = process.cwd();
    const outputDirectory = await mkdtemp(join(root, ".entry-smoke-"));
    outputDirectories.push(outputDirectory);
    await buildEntry(outputDirectory);

    // npm's .bin entries on Unix are symlinks to the real entry; emulate the
    // same canonical-path mismatch with a directory link on every platform.
    const linked = join(outputDirectory, "linked");
    try {
      await symlink(outputDirectory, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) return;
      throw error;
    }

    const result = runEntry(join(linked, "index.js"));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: sentinelloop");
  }, 15_000);
});

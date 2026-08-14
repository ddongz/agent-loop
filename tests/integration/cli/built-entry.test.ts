import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const outputDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(outputDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("built CLI entry", () => {
  it("prints help and exposes the five top-level commands", async () => {
    const root = process.cwd();
    const outputDirectory = await mkdtemp(join(root, ".entry-smoke-"));
    outputDirectories.push(outputDirectory);
    const build = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "--outDir", outputDirectory], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    expect(build.status, build.stderr).toBe(0);

    const result = spawnSync(process.execPath, [join(outputDirectory, "index.js"), "--help"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: sentinelloop");
    for (const command of ["auth", "run", "resume", "status", "report"]) {
      expect(result.stdout).toContain(command);
    }
  }, 15_000);
});

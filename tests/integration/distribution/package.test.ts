import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("npm distribution", () => {
  it("packs only the public runtime and installs a working sentinelloop executable offline", async () => {
    const root = process.cwd();
    const packDirectory = await mkdtemp(join(tmpdir(), "sentinelloop-pack-"));
    const installDirectory = await mkdtemp(join(tmpdir(), "sentinelloop-install-"));
    temporaryDirectories.push(packDirectory, installDirectory);

    await rm(resolve(root, "dist"), { recursive: true, force: true });
    const build = runNpm(["run", "build"], root);
    expect(build.status, build.stderr).toBe(0);

    const packed = runNpm(["pack", "--json", "--pack-destination", packDirectory], root);
    expect(packed.status, packed.stderr).toBe(0);
    const packResult = JSON.parse(packed.stdout) as [{ filename: string; files: Array<{ path: string }> }];
    expect(packResult).toHaveLength(1);

    const packedFiles = packResult[0]!.files.map(({ path }) => path.replaceAll("\\", "/")).sort();
    const distFiles = await listFiles(resolve(root, "dist"));
    const expectedFiles = [
      "LICENSE",
      "README.md",
      "THIRD_PARTY_LICENSES.md",
      "package.json",
      ...distFiles.map((path) => `dist/${path}`),
    ].sort();
    expect(packedFiles).toEqual(expectedFiles);
    expect(packedFiles).toContain("dist/index.js.map");
    expect(packedFiles).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/(^|\/)(tests?|fixtures?|\.env(?:\.|$)|\.sentinelloop|\.superpowers)(\/|$)/i),
    ]));

    const tarball = resolve(packDirectory, packResult[0]!.filename);

    // Warm the npm cache with the exact resolution path the offline install
    // will take: fresh CI runners start with a cold cache, and `npm ci` alone
    // does not guarantee packument entries for every declared range. A real
    // online install seeds the same cache keys the offline run needs.
    const warmDirectory = await mkdtemp(join(tmpdir(), "sentinelloop-warm-"));
    temporaryDirectories.push(warmDirectory);
    await writeFile(join(warmDirectory, "package.json"), '{"private":true}\n', "utf8");
    const warmed = runNpm(
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
      warmDirectory,
    );
    expect(warmed.status, warmed.stderr).toBe(0);

    await writeFile(join(installDirectory, "package.json"), '{"private":true}\n', "utf8");
    const installed = runNpm(
      ["install", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", tarball],
      installDirectory,
    );
    expect(installed.status, installed.stderr).toBe(0);

    const installedManifest = JSON.parse(
      await readFile(join(installDirectory, "node_modules", "sentinelloop-cli", "package.json"), "utf8"),
    ) as { bin?: Record<string, string>; engines?: { node?: string }; license?: string; private?: boolean };
    expect(installedManifest).toMatchObject({
      bin: { sentinelloop: "dist/index.js" },
      engines: { node: ">=22.12.0" },
      license: "MIT",
    });
    expect(installedManifest.private).not.toBe(true);

    const executable = join(
      installDirectory,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "sentinelloop.cmd" : "sentinelloop",
    );
    const help = spawnSync(executable, ["--help"], {
      cwd: installDirectory,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("Usage: sentinelloop");

    const repository = join(installDirectory, "target-repository");
    await mkdir(repository);
    await writeFile(join(repository, ".gitignore"), ".sentinelloop/\n", "utf8");
    await writeFile(join(repository, "package.json"), `${JSON.stringify({
      name: "packaged-runtime-smoke",
      version: "1.0.0",
      private: true,
      scripts: { test: "node --test" },
    }, null, 2)}\n`, "utf8");
    await writeFile(join(repository, "package-lock.json"), `${JSON.stringify({
      name: "packaged-runtime-smoke",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "packaged-runtime-smoke", version: "1.0.0" } },
    }, null, 2)}\n`, "utf8");
    expect(run("git", ["init"], repository).status).toBe(0);
    expect(run("git", ["config", "user.email", "smoke@example.invalid"], repository).status).toBe(0);
    expect(run("git", ["config", "user.name", "SentinelLoop Smoke"], repository).status).toBe(0);
    expect(run("git", ["add", "."], repository).status).toBe(0);
    expect(run("git", ["commit", "-m", "fixture"], repository).status).toBe(0);

    const runtimeEnvironment = {
      ...process.env,
      SENTINELLOOP_CONFIG: join(installDirectory, "missing-config.json"),
    };
    const installedEntry = join(installDirectory, "node_modules", "sentinelloop-cli", "dist", "index.js");
    const runResult = spawnSync(process.execPath, [installedEntry, "run", "Add input validation"], {
      cwd: repository,
      encoding: "utf8",
      env: runtimeEnvironment,
      shell: false,
    });
    expect(runResult.status, runResult.stderr).toBe(64);
    expect(runResult.stderr).toContain("Default profile is not configured");
    expect(runResult.stderr).not.toContain("runtime is not configured");

    const resumeResult = spawnSync(process.execPath, [installedEntry, "resume", "missing-task"], {
      cwd: repository,
      encoding: "utf8",
      env: runtimeEnvironment,
      shell: false,
    });
    expect(resumeResult.status, resumeResult.stderr).toBe(64);
    expect(resumeResult.stderr).toContain("Task missing-task was not found");
    expect(resumeResult.stderr).not.toContain("runtime is not configured");
  }, 60_000);
});

function runNpm(args: readonly string[], cwd: string) {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined) throw new Error("npm_execpath is required for the package smoke test");
  return spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
  });
}

function run(executable: string, args: readonly string[], cwd: string) {
  return spawnSync(executable, [...args], { cwd, encoding: "utf8", shell: false });
}

async function listFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(root, path) : [relative(root, path).replaceAll("\\", "/")];
  }));
  return paths.flat().sort((left, right) => left.localeCompare(right));
}

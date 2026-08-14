import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

export async function createTempRepository(
  name = "sentinelloop 仓库 with spaces",
  packageJson: Record<string, unknown> = { name: "fixture", scripts: { test: "vitest run" } },
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "sentinelloop-task3-"));
  const root = join(parent, name);
  await run("git", ["init", root]);
  await writeFile(join(root, "package.json"), `${JSON.stringify(packageJson)}\n`, "utf8");
  await writeFile(join(root, "package-lock.json"), "{}\n", "utf8");
  await run("git", ["-C", root, "config", "user.email", "tests@example.invalid"]);
  await run("git", ["-C", root, "config", "user.name", "SentinelLoop Tests"]);
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "commit", "-m", "fixture"]);
  return realpath(root);
}

export async function run(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${executable} exited with ${String(code)}`));
    });
  });
}

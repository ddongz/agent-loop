import { access, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { precheckRepository } from "../../../src/repository/workspace.js";
import { createTempRepository, run } from "../../helpers/temp-repository.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(dirname(root), { recursive: true, force: true })));
});

describe("precheckRepository", () => {
  it("accepts a clean repository at a real path containing spaces and non-ASCII characters", async () => {
    const root = await createTempRepository();
    roots.push(root);

    await expect(precheckRepository(root)).resolves.toMatchObject({
      root,
      packageManager: "npm",
      validationPlan: [
        { validator: "test", executable: "npm", args: ["run", "test"], enabled: true },
      ],
    });
  });

  it.each([
    ["tracked", async (root: string) => writeFile(join(root, "package.json"), '{"name":"changed","scripts":{"test":"vitest run"}}\n', "utf8")],
    ["untracked", async (root: string) => writeFile(join(root, "untracked.ts"), "export {};\n", "utf8")],
  ])("rejects a dirty worktree with %s changes", async (_kind, dirty) => {
    const root = await createTempRepository();
    roots.push(root);
    await dirty(root);

    await expect(precheckRepository(root)).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    await expect(access(join(root, ".sentinelloop"))).rejects.toThrow();
  });

  it("rejects a fake .git path that is not a Git repository", async () => {
    const root = await createTempRepository();
    roots.push(root);
    await rm(join(root, ".git"), { recursive: true, force: true });
    await mkdir(join(root, ".git"));

    await expect(precheckRepository(root)).rejects.toMatchObject({ code: "NOT_GIT_REPOSITORY" });
  });

  it("reports a deleted tracked package.json as a dirty worktree first", async () => {
    const root = await createTempRepository();
    roots.push(root);
    await unlink(join(root, "package.json"));

    await expect(precheckRepository(root)).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
  });

  it("reports a dirty worktree before an unsupported Node version", async () => {
    const root = await createTempRepository();
    roots.push(root);
    await writeFile(join(root, "untracked.ts"), "export {};\n", "utf8");

    await expect(precheckRepository(root, { nodeVersion: "21.99.0" })).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
  });

  it("checks the injected Node version at the supported boundary", async () => {
    const root = await createTempRepository();
    roots.push(root);

    await expect(precheckRepository(root, { nodeVersion: "22.12.0" })).resolves.toMatchObject({ root });
    await expect(precheckRepository(root, { nodeVersion: "22.11.9" })).rejects.toMatchObject({
      code: "UNSUPPORTED_NODE_VERSION",
    });
    await expect(precheckRepository(root, { nodeVersion: "22.12.0-rc.1" })).rejects.toMatchObject({
      code: "UNSUPPORTED_NODE_VERSION",
    });
  });

  it("rejects a detached HEAD as unauditable input", async () => {
    const root = await createTempRepository();
    roots.push(root);
    await run("git", ["-C", root, "checkout", "--detach"]);

    await expect(precheckRepository(root)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

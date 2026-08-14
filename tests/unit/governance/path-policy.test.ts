import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSensitiveWorkspacePath,
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
} from "../../../src/governance/path-policy.js";

async function createWorkspace(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "sentinelloop-path-policy-"));
  const root = join(parent, "workspace with spaces 测试");
  await mkdir(join(root, "src"), { recursive: true });
  return realpath(root);
}

describe("normalizeWorkspaceRelativePath", () => {
  it.each([
    ["tests\\unit\\feature.test.ts", "tests/unit/feature.test.ts"],
    ["./tests/功能 feature.test.ts", "tests/功能 feature.test.ts"],
  ])("normalizes %s to a repository-relative POSIX path", (input, expected) => {
    expect(normalizeWorkspaceRelativePath(input)).toBe(expected);
  });

  it.each(["../secret.txt", "src/../../secret.txt", "/etc/passwd", "C:\\Windows\\system.ini", "\\\\server\\share\\file"])(
    "rejects absolute or traversing path %s",
    (input) => {
      expect(() => normalizeWorkspaceRelativePath(input)).toThrowError(
        expect.objectContaining({ code: "PATH_ESCAPE" }),
      );
    },
  );

  it.each([".git/config", ".GIT\\config", ".sentinelloop/state.json", ".env", ".env.local"])(
    "rejects sensitive internal path %s",
    (input) => {
      expect(() => normalizeWorkspaceRelativePath(input)).toThrowError(
        expect.objectContaining({ code: "POLICY_DENIED" }),
      );
    },
  );

  it.each([
    "packages/example/.git/config",
    "src\\generated\\.SENTINELLOOP\\state.json",
    "fixtures/nested/.env",
    "fixtures/nested/.ENV.local/secret",
  ])("rejects a sensitive segment at any depth: %s", (input) => {
    expect(isSensitiveWorkspacePath(input)).toBe(true);
    expect(() => normalizeWorkspaceRelativePath(input)).toThrowError(
      expect.objectContaining({ code: "POLICY_DENIED" }),
    );
  });

  it("exports a non-throwing sensitivity predicate for ordinary paths", () => {
    expect(isSensitiveWorkspacePath("src/environment.ts")).toBe(false);
  });

  it("enforces the shared 1..4096 path-length boundary", () => {
    expect(() => normalizeWorkspaceRelativePath("a".repeat(4_097))).toThrowError(
      expect.objectContaining({ code: "PATH_ESCAPE" }),
    );
  });
});

describe("resolveWorkspacePath", () => {
  it("resolves an existing path beneath the real workspace root", async () => {
    const root = await createWorkspace();
    const source = join(root, "src", "功能 file.ts");
    await writeFile(source, "export {};\n", "utf8");

    await expect(resolveWorkspacePath(root, "src\\功能 file.ts")).resolves.toBe(await realpath(source));
  });

  it("resolves a not-yet-existing target beneath its nearest existing ancestor", async () => {
    const root = await createWorkspace();

    await expect(resolveWorkspacePath(root, "src/new/deep/file.ts")).resolves.toBe(
      join(await realpath(root), "src", "new", "deep", "file.ts"),
    );
  });

  it("rejects traversal before touching the filesystem", async () => {
    const root = await createWorkspace();

    await expect(resolveWorkspacePath(root, "../secret.txt")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("rejects a not-yet-existing target below a symlink or junction that escapes the workspace", async () => {
    const root = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "sentinelloop-path-outside-"));
    const link = join(root, "src", "linked");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");

    await expect(resolveWorkspacePath(root, "src/linked/not-created/file.ts")).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });

  it("does not confuse a sibling with the same workspace prefix for a descendant", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinelloop-path-prefix-"));
    const root = join(parent, "repo");
    const sibling = join(parent, "repo-escaped");
    await mkdir(root);
    await mkdir(sibling);
    await symlink(sibling, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveWorkspacePath(root, "escape/file.ts")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("converts a dangling symlink failure into a stable path escape", async () => {
    const root = await createWorkspace();
    const dangling = join(root, "src", "dangling");
    await symlink(join(root, "missing-target"), dangling, process.platform === "win32" ? "junction" : "dir");

    await expect(resolveWorkspacePath(root, "src/dangling/file.ts")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("rejects a harmless-looking symlink alias that resolves into a sensitive directory", async () => {
    const root = await createWorkspace();
    const internal = join(root, ".git");
    await mkdir(internal);
    await writeFile(join(internal, "config"), "sensitive\n", "utf8");
    await symlink(internal, join(root, "src", "alias"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveWorkspacePath(root, "src/alias/config")).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });
});

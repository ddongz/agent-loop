import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PolicyEngine } from "../../../src/governance/policy-engine.js";
import { createFileTools } from "../../../src/tools/file-tools.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { createTempRepository } from "../../helpers/temp-repository.js";

describe("file tools", () => {
  it("leaves the original bytes unchanged when a patch hunk conflicts", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src"), { recursive: true });
    const target = join(root, "src", "feature.ts");
    const original = Buffer.from("export const value = 1;\r\n", "utf8");
    await writeFile(target, original);
    const patchTool = createFileTools({ workspaceRoot: root }).find(({ type }) => type === "apply_patch");
    if (patchTool === undefined) throw new Error("apply_patch tool was not registered");

    const observation = await patchTool.execute(
      {
        version: 1,
        id: "patch-conflict",
        rationale: "Update the value.",
        type: "apply_patch",
        path: "src/feature.ts",
        patch: "--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-export const value = 2;\n+export const value = 3;\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATCH_CONFLICT" } });
    expect(await readFile(target)).toEqual(original);
  });

  it("truncates UTF-8 reads only at a complete character boundary", async () => {
    const root = await createTempRepository();
    const target = join(root, "说明.txt");
    await writeFile(target, "🙂中文", "utf8");
    const readTool = requiredTool(root, "read_file");

    const observation = await readTool.execute(
      { version: 1, id: "utf8", rationale: "Read bounded text.", type: "read_file", path: "说明.txt", maxBytes: 5 },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "succeeded", output: "🙂", truncated: true, error: null });
  });

  it("lists deterministically while recursively excluding sensitive roots", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "src", ".sentinelloop"));
    await writeFile(join(root, "src", "nested", "可见.ts"), "visible\n", "utf8");
    await writeFile(join(root, "src", "nested", ".env.local"), "SECRET=hidden\n", "utf8");
    await writeFile(join(root, "src", ".sentinelloop", "state.json"), "secret\n", "utf8");
    const listTool = requiredTool(root, "list_files");

    const observation = await listTool.execute(
      { version: 1, id: "list", rationale: "Inspect files.", type: "list_files", maxDepth: 5, maxEntries: 200 },
      new AbortController().signal,
    );

    expect(observation.status).toBe("succeeded");
    expect(observation.output).toContain("src/nested/可见.ts");
    expect(observation.output).not.toMatch(/\.git|\.sentinelloop|\.env/i);
    expect(observation.output.split("\n")).toEqual([...observation.output.split("\n")].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("searches literal text with normalized paths, glob filtering and result bounds", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src folder"));
    await writeFile(join(root, "src folder", "功能.ts"), "needle one\nneedle two\n", "utf8");
    await writeFile(join(root, "src folder", "skip.js"), "needle hidden\n", "utf8");
    await writeFile(join(root, ".env"), "needle secret\n", "utf8");
    const searchTool = requiredTool(root, "search_files");

    const observation = await searchTool.execute(
      { version: 1, id: "search", rationale: "Find symbol.", type: "search_files", query: "needle", glob: "**/*.ts", maxResults: 1 },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "succeeded", truncated: true });
    expect(observation.output).toBe("src folder/功能.ts:1:1:needle one");
    expect(observation.output).not.toContain("secret");
  });

  it("does not mark search output truncated when matches exactly equal the result limit", async () => {
    const root = await createTempRepository();
    await writeFile(join(root, "only.txt"), "unique-needle\n", "utf8");
    const searchTool = requiredTool(root, "search_files");

    const observation = await searchTool.execute(
      { version: 1, id: "exact-limit", rationale: "Find one match.", type: "search_files", query: "unique-needle", maxResults: 1 },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "succeeded", truncated: false });
  });

  it("truncates search output at a valid UTF-8 boundary", async () => {
    const root = await createTempRepository();
    const prefixBytes = Buffer.byteLength("large.txt:1:1:");
    const line = `needle${"a".repeat(65_535 - prefixBytes - Buffer.byteLength("needle"))}界tail`;
    await writeFile(join(root, "large.txt"), line, "utf8");
    const searchTool = requiredTool(root, "search_files");

    const observation = await searchTool.execute(
      { version: 1, id: "utf8-search", rationale: "Bound output.", type: "search_files", query: "needle", maxResults: 10 },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "succeeded", truncated: true });
    expect(observation.output).not.toContain("�");
    expect(Buffer.byteLength(observation.output)).toBe(65_535);
  });

  it("treats a leading double-star directory segment as zero or more directories", async () => {
    const root = await createTempRepository();
    await writeFile(join(root, "root.ts"), "root-needle\n", "utf8");
    const searchTool = requiredTool(root, "search_files");

    const observation = await searchTool.execute(
      { version: 1, id: "root-glob", rationale: "Match root file.", type: "search_files", query: "root-needle", glob: "**/*.ts", maxResults: 10 },
      new AbortController().signal,
    );

    expect(observation.output).toBe("root.ts:1:1:root-needle");
  });

  it("creates a text file atomically without leaving a temporary sibling", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src"));
    const createTool = requiredTool(root, "create_file");

    const observation = await createTool.execute(
      { version: 1, id: "create", rationale: "Create source.", type: "create_file", path: "src/新 file.ts", content: "export {};\n" },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "succeeded", error: null });
    expect(await readFile(join(root, "src", "新 file.ts"), "utf8")).toBe("export {};\n");
    expect((await readdir(join(root, "src"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    ["NUL", "safe\0unsafe"],
    ["UTF-8 byte overflow", "界".repeat(400_000)],
  ])("rejects %s content before creating a file", async (_label, content) => {
    const root = await createTempRepository();
    const createTool = requiredTool(root, "create_file");
    const observation = await createTool.execute(
      { version: 1, id: "invalid-create", rationale: "Create text.", type: "create_file", path: "blocked.txt", content },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "INVALID_INPUT" } });
    await expect(readFile(join(root, "blocked.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-resolves a create path at the mutation boundary and refuses a parent symlink swap", async () => {
    const root = await createTempRepository();
    const source = join(root, "generated");
    const moved = join(root, "generated-before-swap");
    const outside = await mkdtemp(join(tmpdir(), "sentinelloop-create-outside-"));
    await mkdir(source);
    const createTool = createFileTools({
      workspaceRoot: root,
      beforeMutation: async () => {
        await rename(source, moved);
        await symlink(outside, source, process.platform === "win32" ? "junction" : "dir");
      },
    }).find(({ type }) => type === "create_file");
    if (createTool === undefined) throw new Error("create_file tool was not registered");

    const observation = await createTool.execute(
      { version: 1, id: "create-swap", rationale: "Create safely.", type: "create_file", path: "generated/new.txt", content: "inside\n" },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATH_ESCAPE" } });
    await expect(readFile(join(outside, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("applies an LF diff to a CRLF file while preserving its line endings", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src"));
    const target = join(root, "src", "crlf.ts");
    await writeFile(target, "one\r\ntwo\r\n", "utf8");
    const patchTool = requiredTool(root, "apply_patch");

    const observation = await patchTool.execute(
      {
        version: 1, id: "crlf", rationale: "Patch one line.", type: "apply_patch", path: "src/crlf.ts",
        patch: "--- a/src/crlf.ts\n+++ b/src/crlf.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+changed\n",
      },
      new AbortController().signal,
    );

    expect(observation.status).toBe("succeeded");
    expect(await readFile(target, "utf8")).toBe("one\r\nchanged\r\n");
  });

  it("dispatches a patch whose repository-relative path contains spaces and non-ASCII", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src folder"));
    const target = join(root, "src folder", "功能 file.ts");
    await writeFile(target, "old\n", "utf8");
    const registry = new ToolRegistry(new PolicyEngine(), createFileTools({ workspaceRoot: root }));

    const observation = await registry.dispatch(
      { workspaceRoot: root, phase: "IMPLEMENT", protectedTests: [], baselineVersion: 0 },
      {
        version: 1, id: "spaced-patch", rationale: "Patch a Unicode path.", type: "apply_patch", path: "src folder/功能 file.ts",
        patch: "--- a/src folder/功能 file.ts\n+++ b/src folder/功能 file.ts\n@@ -1 +1 @@\n-old\n+new\n",
      },
    );

    expect(observation).toMatchObject({ status: "succeeded", error: null });
    expect(await readFile(target, "utf8")).toBe("new\n");
  });

  it("rejects repeated hunk context as ambiguous and preserves original bytes", async () => {
    const root = await createTempRepository();
    const target = join(root, "repeat.txt");
    const original = Buffer.from("same\nsame\n", "utf8");
    await writeFile(target, original);
    const patchTool = requiredTool(root, "apply_patch");

    const observation = await patchTool.execute(
      {
        version: 1, id: "ambiguous", rationale: "Patch repeated text.", type: "apply_patch", path: "repeat.txt",
        patch: "--- a/repeat.txt\n+++ b/repeat.txt\n@@ -1 +1 @@\n-same\n+changed\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATCH_CONFLICT" } });
    expect(await readFile(target)).toEqual(original);
  });

  it("rejects exact text when the hunk old coordinate points at a different line", async () => {
    const root = await createTempRepository();
    const target = join(root, "coordinates.txt");
    const original = Buffer.from("first\nsecond\n", "utf8");
    await writeFile(target, original);
    const patchTool = requiredTool(root, "apply_patch");

    const observation = await patchTool.execute(
      {
        version: 1, id: "wrong-old-coordinate", rationale: "Patch exact coordinate.", type: "apply_patch", path: "coordinates.txt",
        patch: "--- a/coordinates.txt\n+++ b/coordinates.txt\n@@ -1 +1 @@\n-second\n+changed\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATCH_CONFLICT" } });
    expect(await readFile(target)).toEqual(original);
  });

  it("applies ordered hunks using original and accumulated output coordinates", async () => {
    const root = await createTempRepository();
    const target = join(root, "multi-hunk.txt");
    await writeFile(target, "a\nb\nc\n", "utf8");
    const patchTool = requiredTool(root, "apply_patch");

    const observation = await patchTool.execute(
      {
        version: 1, id: "multi-coordinate", rationale: "Apply ordered hunks.", type: "apply_patch", path: "multi-hunk.txt",
        patch: "--- a/multi-hunk.txt\n+++ b/multi-hunk.txt\n@@ -1,0 +2 @@\n+x\n@@ -3 +4 @@\n-c\n+C\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "succeeded", error: null });
    expect(await readFile(target, "utf8")).toBe("a\nx\nb\nC\n");
  });

  it("never lets a later hunk consume text introduced by an earlier hunk", async () => {
    const root = await createTempRepository();
    const target = join(root, "introduced.txt");
    const original = Buffer.from("alpha\nbeta\n", "utf8");
    await writeFile(target, original);
    const patchTool = requiredTool(root, "apply_patch");

    const observation = await patchTool.execute(
      {
        version: 1, id: "introduced-context", rationale: "Reject introduced context.", type: "apply_patch", path: "introduced.txt",
        patch: "--- a/introduced.txt\n+++ b/introduced.txt\n@@ -1 +1 @@\n-alpha\n+introduced\n@@ -2 +2 @@\n-introduced\n+changed\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATCH_CONFLICT" } });
    expect(await readFile(target)).toEqual(original);
  });

  it("rejects impossible new-file hunk coordinates", async () => {
    const root = await createTempRepository();
    const target = join(root, "new-coordinate.txt");
    const original = Buffer.from("one\n", "utf8");
    await writeFile(target, original);
    const patchTool = requiredTool(root, "apply_patch");
    const observation = await patchTool.execute(
      {
        version: 1, id: "wrong-new-coordinate", rationale: "Reject metadata.", type: "apply_patch", path: "new-coordinate.txt",
        patch: "--- a/new-coordinate.txt\n+++ b/new-coordinate.txt\n@@ -1 +2 @@\n-one\n+ONE\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATCH_CONFLICT" } });
    expect(await readFile(target)).toEqual(original);
  });

  it("adds an EOF newline when only the old diff side has the no-newline marker", async () => {
    const root = await createTempRepository();
    const target = join(root, "add-eof-newline.txt");
    await writeFile(target, "old", "utf8");
    const patchTool = requiredTool(root, "apply_patch");
    const observation = await patchTool.execute(
      {
        version: 1, id: "add-eof", rationale: "Add EOF newline.", type: "apply_patch", path: "add-eof-newline.txt",
        patch: "--- a/add-eof-newline.txt\n+++ b/add-eof-newline.txt\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+old\n",
      },
      new AbortController().signal,
    );

    expect(observation.status).toBe("succeeded");
    expect(await readFile(target)).toEqual(Buffer.from("old\n"));
  });

  it("removes an EOF newline when only the new diff side has the no-newline marker", async () => {
    const root = await createTempRepository();
    const target = join(root, "remove-eof-newline.txt");
    await writeFile(target, "old\n", "utf8");
    const patchTool = requiredTool(root, "apply_patch");
    const observation = await patchTool.execute(
      {
        version: 1, id: "remove-eof", rationale: "Remove EOF newline.", type: "apply_patch", path: "remove-eof-newline.txt",
        patch: "--- a/remove-eof-newline.txt\n+++ b/remove-eof-newline.txt\n@@ -1 +1 @@\n-old\n+old\n\\ No newline at end of file\n",
      },
      new AbortController().signal,
    );

    expect(observation.status).toBe("succeeded");
    expect(await readFile(target)).toEqual(Buffer.from("old"));
  });

  it("preserves untouched mixed line endings and inherits the replaced line ending", async () => {
    const root = await createTempRepository();
    const target = join(root, "mixed-endings.txt");
    await writeFile(target, Buffer.from("one\r\ntwo\nthree\r\n", "utf8"));
    const patchTool = requiredTool(root, "apply_patch");
    const observation = await patchTool.execute(
      {
        version: 1, id: "mixed-endings", rationale: "Preserve untouched bytes.", type: "apply_patch", path: "mixed-endings.txt",
        patch: "--- a/mixed-endings.txt\n+++ b/mixed-endings.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n",
      },
      new AbortController().signal,
    );

    expect(observation.status).toBe("succeeded");
    expect(await readFile(target)).toEqual(Buffer.from("one\r\nTWO\nthree\r\n", "utf8"));
  });

  it("rejects a multi-file patch even when the first header matches", async () => {
    const root = await createTempRepository();
    await writeFile(join(root, "one.txt"), "one\n", "utf8");
    const patchTool = requiredTool(root, "apply_patch");
    const observation = await patchTool.execute(
      {
        version: 1, id: "multi", rationale: "Patch files.", type: "apply_patch", path: "one.txt",
        patch: "--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-one\n+ONE\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-two\n+TWO\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATCH_CONFLICT" } });
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("one\n");
  });

  it("rejects binary target bytes and leaves them unchanged", async () => {
    const root = await createTempRepository();
    const target = join(root, "binary.bin");
    const original = Buffer.from([0xff, 0x00, 0x10]);
    await writeFile(target, original);
    const patchTool = requiredTool(root, "apply_patch");

    const observation = await patchTool.execute(
      {
        version: 1, id: "binary", rationale: "Reject binary patch.", type: "apply_patch", path: "binary.bin",
        patch: "--- a/binary.bin\n+++ b/binary.bin\n@@ -1 +1 @@\n-old\n+new\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "INVALID_INPUT" } });
    expect(await readFile(target)).toEqual(original);
  });

  it("re-resolves a patch path at the mutation boundary and rejects a symlink swap", async () => {
    const root = await createTempRepository();
    const source = join(root, "src");
    const moved = join(root, "src-before-swap");
    const outside = await mkdtemp(join(tmpdir(), "sentinelloop-tool-outside-"));
    await mkdir(source);
    await writeFile(join(source, "target.txt"), "inside\n", "utf8");
    await writeFile(join(outside, "target.txt"), "outside\n", "utf8");
    const patchTool = createFileTools({
      workspaceRoot: root,
      beforeMutation: async () => {
        await rename(source, moved);
        await symlink(outside, source, process.platform === "win32" ? "junction" : "dir");
      },
    }).find(({ type }) => type === "apply_patch");
    if (patchTool === undefined) throw new Error("apply_patch tool was not registered");

    const observation = await patchTool.execute(
      {
        version: 1, id: "swap", rationale: "Patch safely.", type: "apply_patch", path: "src/target.txt",
        patch: "--- a/src/target.txt\n+++ b/src/target.txt\n@@ -1 +1 @@\n-inside\n+changed\n",
      },
      new AbortController().signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "PATH_ESCAPE" } });
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("outside\n");
    expect(await readFile(join(moved, "target.txt"), "utf8")).toBe("inside\n");
    expect((await readdir(moved)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

function requiredTool(root: string, type: "read_file" | "list_files" | "search_files" | "create_file" | "apply_patch") {
  const result = createFileTools({ workspaceRoot: root }).find((tool) => tool.type === type);
  if (result === undefined) throw new Error(`${type} tool was not registered`);
  return result;
}

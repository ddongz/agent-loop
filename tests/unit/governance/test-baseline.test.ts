import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TestBaseline } from "../../../src/governance/test-baseline.js";
import { createTempRepository } from "../../helpers/temp-repository.js";

const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await createTempRepository("baseline repo 测试");
  roots.push(dirname(root));
  return root;
}

async function put(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TestBaseline", () => {
  it("freezes normalized paths, SHA-256 hashes, diff and confirmation metadata", async () => {
    const root = await repository();
    await put(root, "tests/feature test.ts", "expect(answer).toBe(42);\n");

    const baseline = await TestBaseline.freeze({
      root,
      testPaths: ["tests\\feature test.ts"],
      frozenDiff: "diff --git a/tests/feature test.ts b/tests/feature test.ts",
      confirmedAt: "2026-08-14T10:00:00.000Z",
      version: 3,
    });

    expect(baseline.version).toBe(3);
    expect(baseline.protectedTests).toEqual([
      {
        path: "tests/feature test.ts",
        sha256: "e89b0aadb3149c587aa5b2f25305992e76f7d865a7384ce24710ed00a2a72ef5",
        frozenAt: "2026-08-14T10:00:00.000Z",
      },
    ]);
    expect(baseline.frozenDiff).toContain("diff --git");
    expect(baseline.confirmedAt).toBe("2026-08-14T10:00:00.000Z");
    expect(baseline.approvedVersions).toEqual([]);
  });

  it("rejects an empty or duplicate freeze set after path normalization", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "test('feature', () => {});\n");

    await expect(
      TestBaseline.freeze({ root, testPaths: [], frozenDiff: "diff", confirmedAt: "2026-08-14T10:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      TestBaseline.freeze({
        root,
        testPaths: ["tests/feature.test.ts", "tests\\feature.test.ts"],
        frozenDiff: "diff",
        confirmedAt: "2026-08-14T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects a parseable date that is not an ISO-8601 instant", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "test('feature', () => {});\n");

    await expect(
      TestBaseline.freeze({
        root,
        testPaths: ["tests/feature.test.ts"],
        frozenDiff: "diff",
        confirmedAt: "2026-08-14",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it.runIf(process.platform === "win32")("treats Windows path case variants as duplicate baseline entries", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "test('feature', () => {});\n");

    await expect(
      TestBaseline.freeze({
        root,
        testPaths: ["tests/feature.test.ts", "Tests/Feature.test.ts"],
        frozenDiff: "diff",
        confirmedAt: "2026-08-14T10:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("reports changed, missing, added and duplicate test paths deterministically", async () => {
    const root = await repository();
    await put(root, "tests/a.test.ts", "a-v1\n");
    await put(root, "tests/b.test.ts", "b-v1\n");
    const baseline = await TestBaseline.freeze({
      root,
      testPaths: ["tests/b.test.ts", "tests/a.test.ts"],
      frozenDiff: "diff",
      confirmedAt: "2026-08-14T10:00:00.000Z",
      version: 2,
    });
    await put(root, "tests/a.test.ts", "a-v2\n");
    await rm(join(root, "tests", "b.test.ts"));
    await put(root, "tests/c.test.ts", "c-v1\n");

    await expect(
      baseline.verify({
        root,
        testPaths: ["tests/c.test.ts", "tests\\a.test.ts", "tests/a.test.ts"],
        baselineVersion: 2,
      }),
    ).resolves.toEqual({
      matches: false,
      expectedVersion: 2,
      actualVersion: 2,
      missingPaths: ["tests/b.test.ts"],
      changedPaths: ["tests/a.test.ts"],
      addedPaths: ["tests/c.test.ts"],
      duplicatePaths: ["tests/a.test.ts"],
    });
  });

  it("fails verification when the supplied baseline version is stale", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "v1\n");
    const baseline = await TestBaseline.freeze({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff",
      confirmedAt: "2026-08-14T10:00:00.000Z",
      version: 4,
    });

    const result = await baseline.verify({
      root,
      testPaths: ["tests/feature.test.ts"],
      baselineVersion: 3,
    });

    expect(result).toMatchObject({ matches: false, expectedVersion: 4, actualVersion: 3 });
  });

  it("records a confirmed approved successor version without mutating the frozen instance", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "v1\n");
    const baseline = await TestBaseline.freeze({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff",
      confirmedAt: "2026-08-14T10:00:00.000Z",
      version: 1,
    });

    const successor = baseline.recordApprovedVersion(2, "2026-08-14T11:00:00.000Z");

    expect(baseline.approvedVersions).toEqual([]);
    expect(successor.approvedVersions).toEqual([{ version: 2, approvedAt: "2026-08-14T11:00:00.000Z" }]);
  });
});

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TestBaselineSchema } from "../../../src/domain/task.js";
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

  it("creates an approved successor with fresh hashes and makes it the verifiable current version", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "v1\n");
    const baseline = await TestBaseline.freeze({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff",
      confirmedAt: "2026-08-14T10:00:00.000Z",
      version: 1,
    });
    await put(root, "tests/feature.test.ts", "v2\n");

    const successor = await baseline.approveMutation({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff-v2",
      approvedAt: "2026-08-14T11:00:00.000Z",
    });

    expect(baseline.version).toBe(1);
    expect(baseline.approvedVersions).toEqual([]);
    expect(successor.version).toBe(2);
    expect(successor.approvedVersions).toEqual([{ version: 2, approvedAt: "2026-08-14T11:00:00.000Z" }]);
    expect(successor.protectedTests).toEqual([{
      path: "tests/feature.test.ts",
      sha256: "81db67b6a5702b9b68f0016f061c409bf3fb16d062fc854d1b424bb4e9c28c56",
      frozenAt: "2026-08-14T11:00:00.000Z",
    }]);
    await expect(successor.verify({
      root,
      testPaths: ["tests/feature.test.ts"],
      baselineVersion: 2,
    })).resolves.toMatchObject({ matches: true, expectedVersion: 2, actualVersion: 2 });
    await expect(successor.verify({
      root,
      testPaths: ["tests/feature.test.ts"],
      baselineVersion: 1,
    })).resolves.toMatchObject({ matches: false, expectedVersion: 2, actualVersion: 1 });
    expect(successor.taskStateSummary()).toEqual({
      protectedTests: successor.protectedTests,
      baselineVersion: 2,
    });
  });

  it("requires strictly increasing approval timestamps and advances versions exactly once", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "v1\n");
    const baseline = await TestBaseline.freeze({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff-v1",
      confirmedAt: "2026-08-14T10:00:00.000Z",
      version: 3,
    });

    await expect(baseline.approveMutation({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff-v2",
      approvedAt: "2026-08-14T10:00:00.000Z",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const successor = await baseline.approveMutation({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff-v2",
      approvedAt: "2026-08-14T11:00:00.000Z",
    });

    expect(successor.version).toBe(4);
    await expect(successor.approveMutation({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff-v3",
      approvedAt: "2026-08-14T10:59:59.000Z",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("round-trips a strict persisted snapshot and restores verification behavior", async () => {
    const root = await repository();
    await put(root, "tests/feature.test.ts", "v1\n");
    const baseline = await TestBaseline.freeze({
      root,
      testPaths: ["tests/feature.test.ts"],
      frozenDiff: "diff-v1",
      confirmedAt: "2026-08-14T10:00:00.000Z",
    });
    const snapshot = baseline.snapshot();

    expect(TestBaselineSchema.parse(snapshot)).toEqual(snapshot);
    const restored = TestBaseline.restore(JSON.parse(JSON.stringify(snapshot)) as unknown);
    expect(restored.snapshot()).toEqual(snapshot);
    await expect(restored.verify({
      root,
      testPaths: ["tests/feature.test.ts"],
      baselineVersion: 1,
    })).resolves.toMatchObject({ matches: true });
  });

  it("rejects non-monotonic or structurally inconsistent persisted histories", () => {
    const entry = {
      version: 1,
      protectedTests: [{ path: "tests/feature.test.ts", sha256: "a".repeat(64), frozenAt: "2026-08-14T10:00:00.000Z" }],
      frozenDiff: "diff-v1",
      confirmedAt: "2026-08-14T10:00:00.000Z",
      approval: null,
    };
    const invalid = {
      schemaVersion: 1,
      currentVersion: 3,
      versions: [
        entry,
        {
          ...entry,
          version: 3,
          confirmedAt: "2026-08-14T09:00:00.000Z",
          approval: { previousVersion: 1, approvedAt: "2026-08-14T09:00:00.000Z" },
        },
      ],
    };

    expect(() => TestBaseline.restore(invalid)).toThrowError();
  });

  it.each([".git/config", "tests/.env.local", "C:/outside.test.ts"])(
    "rejects persisted baseline path that cannot pass the canonical path policy: %s",
    (path) => {
      const snapshot = {
        schemaVersion: 1,
        currentVersion: 1,
        versions: [{
          version: 1,
          protectedTests: [{ path, sha256: "a".repeat(64), frozenAt: "2026-08-14T10:00:00.000Z" }],
          frozenDiff: "diff",
          confirmedAt: "2026-08-14T10:00:00.000Z",
          approval: null,
        }],
      };

      expect(() => TestBaseline.restore(snapshot)).toThrowError(
        expect.objectContaining({ code: "STATE_CORRUPT" }),
      );
    },
  );
});

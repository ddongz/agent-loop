import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { SentinelError } from "../domain/error.js";
import {
  TestBaselineSchema,
  type ProtectedTestRef,
  type TestBaseline as TestBaselineSnapshot,
  type TestBaselineVersion,
} from "../domain/task.js";
import { normalizeWorkspaceRelativePath, resolveWorkspacePath } from "./path-policy.js";

export interface FreezeBaselineInput {
  root: string;
  testPaths: readonly string[];
  frozenDiff: string;
  confirmedAt: string;
  version?: number;
}

export interface ApproveBaselineMutationInput {
  root: string;
  testPaths: readonly string[];
  frozenDiff: string;
  approvedAt: string;
}

export interface VerifyBaselineInput {
  root: string;
  testPaths: readonly string[];
  baselineVersion: number;
}

export interface BaselineVerification {
  matches: boolean;
  expectedVersion: number;
  actualVersion: number;
  missingPaths: string[];
  changedPaths: string[];
  addedPaths: string[];
  duplicatePaths: string[];
}

export interface ApprovedBaselineVersion {
  version: number;
  approvedAt: string;
}

export interface TaskStateBaselineSummary {
  protectedTests: readonly ProtectedTestRef[];
  baselineVersion: number;
}

export class TestBaseline {
  readonly #state: TestBaselineSnapshot;

  private constructor(snapshot: TestBaselineSnapshot) {
    this.#state = freezeSnapshot(snapshot);
  }

  get version(): number {
    return this.#state.currentVersion;
  }

  get protectedTests(): readonly ProtectedTestRef[] {
    return this.current.protectedTests;
  }

  get frozenDiff(): string {
    return this.current.frozenDiff;
  }

  get confirmedAt(): string {
    return this.current.confirmedAt;
  }

  get approvedVersions(): readonly ApprovedBaselineVersion[] {
    return this.#state.versions.flatMap((entry) => entry.approval === null
      ? []
      : [{ version: entry.version, approvedAt: entry.approval.approvedAt }]);
  }

  private get current(): TestBaselineVersion {
    const current = this.#state.versions.at(-1);
    if (current === undefined) throw new SentinelError({ code: "STATE_CORRUPT", message: "Baseline history is empty." });
    return current;
  }

  static async freeze(input: FreezeBaselineInput): Promise<TestBaseline> {
    assertTimestamp(input.confirmedAt);
    const version = input.version ?? 1;
    if (!Number.isInteger(version) || version < 1) invalidBaseline("Baseline version must be a positive integer.");
    const protectedTests = await captureTests(input.root, input.testPaths, input.confirmedAt);
    return TestBaseline.restore({
      schemaVersion: 1,
      currentVersion: version,
      versions: [{
        version,
        protectedTests,
        frozenDiff: input.frozenDiff,
        confirmedAt: input.confirmedAt,
        approval: null,
      }],
    });
  }

  static restore(snapshot: unknown): TestBaseline {
    const parsed = TestBaselineSchema.safeParse(snapshot);
    if (!parsed.success) {
      throw new SentinelError({
        code: "STATE_CORRUPT",
        message: "Persisted test baseline is invalid.",
        detail: { issues: parsed.error.issues.map(({ message }) => message) },
      });
    }
    try {
      for (const version of parsed.data.versions) {
        for (const test of version.protectedTests) {
          if (normalizeWorkspaceRelativePath(test.path) !== test.path) {
            throw new Error("Path is not in canonical repository-relative POSIX form.");
          }
        }
      }
    } catch (error) {
      throw new SentinelError({
        code: "STATE_CORRUPT",
        message: "Persisted test baseline contains a path rejected by workspace policy.",
        cause: error,
      });
    }
    return new TestBaseline(parsed.data);
  }

  snapshot(): TestBaselineSnapshot {
    return TestBaselineSchema.parse(this.#state);
  }

  taskStateSummary(): TaskStateBaselineSummary {
    return {
      protectedTests: this.protectedTests.map((entry) => ({ ...entry })),
      baselineVersion: this.version,
    };
  }

  async approveMutation(input: ApproveBaselineMutationInput): Promise<TestBaseline> {
    assertTimestamp(input.approvedAt);
    if (Date.parse(input.approvedAt) <= Date.parse(this.confirmedAt)) {
      invalidBaseline("An approved baseline mutation must have a strictly newer timestamp.");
    }
    const protectedTests = await captureTests(input.root, input.testPaths, input.approvedAt);
    const version = this.version + 1;
    return TestBaseline.restore({
      schemaVersion: 1,
      currentVersion: version,
      versions: [
        ...this.#state.versions,
        {
          version,
          protectedTests,
          frozenDiff: input.frozenDiff,
          confirmedAt: input.approvedAt,
          approval: { previousVersion: this.version, approvedAt: input.approvedAt },
        },
      ],
    });
  }

  async verify(input: VerifyBaselineInput): Promise<BaselineVerification> {
    const { normalized, duplicates } = normalizeSet(input.testPaths);
    const currentPaths = new Set(normalized);
    const frozenPaths = new Set(this.protectedTests.map(({ path }) => path));
    const missingPaths = this.protectedTests
      .filter(({ path }) => !currentPaths.has(path))
      .map(({ path }) => path);
    const addedPaths = normalized.filter((path) => !frozenPaths.has(path));
    const changedPaths: string[] = [];

    for (const entry of this.protectedTests) {
      if (!currentPaths.has(entry.path)) continue;
      try {
        const absolute = await resolveWorkspacePath(input.root, entry.path);
        const metadata = await stat(absolute);
        if (!metadata.isFile() || sha256(await readFile(absolute)) !== entry.sha256) changedPaths.push(entry.path);
      } catch (error) {
        if (isMissingPathError(error)) missingPaths.push(entry.path);
        else throw error;
      }
    }

    const uniqueMissing = [...new Set(missingPaths)].sort(comparePaths);
    changedPaths.sort(comparePaths);
    addedPaths.sort(comparePaths);
    duplicates.sort(comparePaths);
    return {
      matches: input.baselineVersion === this.version
        && uniqueMissing.length === 0
        && changedPaths.length === 0
        && addedPaths.length === 0
        && duplicates.length === 0,
      expectedVersion: this.version,
      actualVersion: input.baselineVersion,
      missingPaths: uniqueMissing,
      changedPaths,
      addedPaths,
      duplicatePaths: duplicates,
    };
  }
}

async function captureTests(root: string, paths: readonly string[], frozenAt: string): Promise<ProtectedTestRef[]> {
  if (paths.length === 0) invalidBaseline("A baseline requires at least one target test.");
  const { normalized, duplicates } = normalizeSet(paths);
  if (duplicates.length > 0) invalidBaseline("A baseline cannot contain duplicate normalized test paths.");

  return Promise.all(normalized.map(async (path): Promise<ProtectedTestRef> => {
    const absolute = await resolveWorkspacePath(root, path);
    let metadata;
    try {
      metadata = await stat(absolute);
    } catch (error) {
      throw invalidBaselineError(`Cannot freeze missing test: ${path}`, error);
    }
    if (!metadata.isFile()) throw invalidBaselineError(`Cannot freeze a non-file test: ${path}`);
    return { path, sha256: sha256(await readFile(absolute)), frozenAt };
  }));
}

function normalizeSet(paths: readonly string[]): { normalized: string[]; duplicates: string[] } {
  const normalized = paths.map((path) => {
    const normalizedPath = normalizeWorkspaceRelativePath(path);
    return process.platform === "win32" ? normalizedPath.toLocaleLowerCase("en-US") : normalizedPath;
  });
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of normalized) {
    if (seen.has(path)) duplicates.add(path);
    seen.add(path);
  }
  return { normalized: [...seen].sort(comparePaths), duplicates: [...duplicates] };
}

function freezeSnapshot(snapshot: TestBaselineSnapshot): TestBaselineSnapshot {
  const versions = snapshot.versions.map((entry) => Object.freeze({
    ...entry,
    protectedTests: Object.freeze(entry.protectedTests.map((test) => Object.freeze({ ...test }))),
    approval: entry.approval === null ? null : Object.freeze({ ...entry.approval }),
  }));
  return Object.freeze({ ...snapshot, versions: Object.freeze(versions) }) as unknown as TestBaselineSnapshot;
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, "en");
}

function assertTimestamp(value: string): void {
  const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!instantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    invalidBaseline("Baseline timestamps must be ISO-8601 instants.");
  }
}

function invalidBaseline(message: string): never {
  throw invalidBaselineError(message);
}

function invalidBaselineError(message: string, cause?: unknown): SentinelError {
  return new SentinelError({ code: "INVALID_INPUT", message, cause });
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import type { ProtectedTestRef } from "../domain/task.js";
import { SentinelError } from "../domain/error.js";
import { normalizeWorkspaceRelativePath, resolveWorkspacePath } from "./path-policy.js";

export interface FreezeBaselineInput {
  root: string;
  testPaths: readonly string[];
  frozenDiff: string;
  confirmedAt: string;
  version?: number;
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

export class TestBaseline {
  readonly version: number;
  readonly protectedTests: readonly ProtectedTestRef[];
  readonly frozenDiff: string;
  readonly confirmedAt: string;
  readonly approvedVersions: readonly ApprovedBaselineVersion[];

  private constructor(
    version: number,
    protectedTests: readonly ProtectedTestRef[],
    frozenDiff: string,
    confirmedAt: string,
    approvedVersions: readonly ApprovedBaselineVersion[] = [],
  ) {
    this.version = version;
    this.protectedTests = Object.freeze(protectedTests.map((entry) => Object.freeze({ ...entry })));
    this.frozenDiff = frozenDiff;
    this.confirmedAt = confirmedAt;
    this.approvedVersions = Object.freeze(approvedVersions.map((entry) => Object.freeze({ ...entry })));
  }

  static async freeze(input: FreezeBaselineInput): Promise<TestBaseline> {
    assertTimestamp(input.confirmedAt);
    const version = input.version ?? 1;
    if (!Number.isInteger(version) || version < 1) invalidBaseline("Baseline version must be a positive integer.");
    if (input.testPaths.length === 0) invalidBaseline("A baseline requires at least one target test.");

    const { normalized, duplicates } = normalizeSet(input.testPaths);
    if (duplicates.length > 0) invalidBaseline("A baseline cannot contain duplicate normalized test paths.");

    const protectedTests = await Promise.all(normalized.map(async (path): Promise<ProtectedTestRef> => {
      const absolute = await resolveWorkspacePath(input.root, path);
      let metadata;
      try {
        metadata = await stat(absolute);
      } catch (error) {
        throw invalidBaselineError(`Cannot freeze missing test: ${path}`, error);
      }
      if (!metadata.isFile()) throw invalidBaselineError(`Cannot freeze a non-file test: ${path}`);
      return {
        path,
        sha256: sha256(await readFile(absolute)),
        frozenAt: input.confirmedAt,
      };
    }));

    return new TestBaseline(version, protectedTests, input.frozenDiff, input.confirmedAt);
  }

  async verify(input: VerifyBaselineInput): Promise<BaselineVerification> {
    const { normalized, duplicates } = normalizeSet(input.testPaths);
    const current = new Set(normalized);
    const frozen = new Set(this.protectedTests.map(({ path }) => path));
    const missingPaths = this.protectedTests
      .filter(({ path }) => !current.has(path))
      .map(({ path }) => path);
    const addedPaths = normalized.filter((path) => !frozen.has(path));
    const changedPaths: string[] = [];

    for (const entry of this.protectedTests) {
      if (!current.has(entry.path)) continue;
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

  recordApprovedVersion(version: number, approvedAt: string): TestBaseline {
    assertTimestamp(approvedAt);
    if (!Number.isInteger(version) || version <= this.version || this.approvedVersions.some((entry) => entry.version === version)) {
      invalidBaseline("An approved baseline version must be unique and newer than the frozen version.");
    }
    return new TestBaseline(
      this.version,
      this.protectedTests,
      this.frozenDiff,
      this.confirmedAt,
      [...this.approvedVersions, { version, approvedAt }].sort((left, right) => left.version - right.version),
    );
  }
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

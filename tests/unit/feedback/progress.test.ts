import { describe, expect, it } from "vitest";

import type { ValidationIssue, ValidationResult, ValidatorName } from "../../../src/domain/validation.js";
import { detectProgress, type ProgressSnapshot } from "../../../src/feedback/progress.js";

const issue = (fingerprint: string, severity: ValidationIssue["severity"] = "error"): ValidationIssue => ({
  category: "TEST_ASSERTION", severity, message: fingerprint, file: null, line: null, column: null,
  rule: null, testName: fingerprint, fingerprint,
});
const result = (validator: ValidatorName, status: ValidationResult["status"], fingerprints: string[]): ValidationResult => ({
  validator, status, exitCode: status === "passed" ? 0 : 1, command: { executable: "npm", args: ["test"] },
  startedAt: "2026-08-14T00:00:00.000Z", durationMs: 1, issues: fingerprints.map((value) => issue(value)),
  stdoutSummary: "", stderrSummary: "", stdoutTruncated: false, stderrTruncated: false,
});
const snapshot = (stage: ValidatorName, fingerprints: string[], diff = "diff --git a/src/a.ts b/src/a.ts"): ProgressSnapshot => ({
  results: [result(stage, "failed", fingerprints)], diff,
});
describe("detectProgress", () => {
  it("treats issue ordering and duplicates as unchanged", () => {
    expect(detectProgress([snapshot("test", ["a", "b"]), snapshot("test", ["b", "a", "a"])])).toEqual({
      kind: "unchanged", repeated: ["a", "b"],
    });
  });

  it("ranks advancement to a later validation stage above issue-count changes", () => {
    expect(detectProgress([snapshot("test", ["a"]), snapshot("typecheck", ["b", "c", "d"])]).kind).toBe("improved");
    expect(detectProgress([snapshot("lint", ["a"]), snapshot("test", [])]).kind).toBe("regressed");
  });

  it("reports literal resolved and introduced fingerprint deltas", () => {
    expect(detectProgress([snapshot("test", ["a", "b"]), snapshot("test", ["b", "c"])] )).toEqual({
      kind: "regressed", introduced: ["c"],
    });
    expect(detectProgress([snapshot("test", ["a", "b"]), snapshot("test", ["b"])] )).toEqual({
      kind: "improved", resolved: ["a"], introduced: [],
    });
  });

  it("detects a length-2 cycle only after two complete alternating periods", () => {
    expect(detectProgress([snapshot("test", ["a"]), snapshot("test", ["b"]), snapshot("test", ["a"])]).kind).not.toBe("oscillating");
    expect(detectProgress([
      snapshot("test", ["a"]), snapshot("test", ["b"]), snapshot("test", ["a"]), snapshot("test", ["b"]),
    ])).toEqual({ kind: "oscillating", cycleLength: 2 });
  });

  it("detects a length-3 cycle after two complete periods", () => {
    expect(detectProgress([
      snapshot("test", ["a"]), snapshot("test", ["b"]), snapshot("test", ["c"]),
      snapshot("test", ["a"]), snapshot("test", ["b"]), snapshot("test", ["c"]),
    ])).toEqual({ kind: "oscillating", cycleLength: 3 });
  });

  it("does not call reordered identical sets an oscillation", () => {
    expect(detectProgress([
      snapshot("test", ["a", "b"]), snapshot("test", ["b", "a"]),
      snapshot("test", ["a", "b"]), snapshot("test", ["b", "a"]),
    ])).toEqual({ kind: "unchanged", repeated: ["a", "b"] });
  });
});

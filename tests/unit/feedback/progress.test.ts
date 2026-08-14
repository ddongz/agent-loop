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

  it("does not fabricate a cycle from a constant failure set and alternating diffs", () => {
    expect(detectProgress([
      snapshot("test", ["a"], "+const value = 1;"),
      snapshot("test", ["a"], "+const value = 2;"),
      snapshot("test", ["a"], "+const value = 1;"),
      snapshot("test", ["a"], "+const value = 2;"),
    ]).kind).not.toBe("oscillating");
  });

  it("detects a true failure-set cycle even when every diff is different", () => {
    expect(detectProgress([
      snapshot("test", ["a"], "+const attempt = 1;"),
      snapshot("test", ["b"], "+const attempt = 2;"),
      snapshot("test", ["a"], "+const attempt = 3;"),
      snapshot("test", ["b"], "+const attempt = 4;"),
    ])).toEqual({ kind: "oscillating", cycleLength: 2 });
    expect(detectProgress([
      snapshot("test", ["a"], "+const attempt = 1;"),
      snapshot("test", ["b"], "+const attempt = 2;"),
      snapshot("test", ["c"], "+const attempt = 3;"),
      snapshot("test", ["a"], "+const attempt = 4;"),
      snapshot("test", ["b"], "+const attempt = 5;"),
      snapshot("test", ["c"], "+const attempt = 6;"),
    ])).toEqual({ kind: "oscillating", cycleLength: 3 });
  });

  it("does not call reordered identical sets an oscillation", () => {
    expect(detectProgress([
      snapshot("test", ["a", "b"]), snapshot("test", ["b", "a"]),
      snapshot("test", ["a", "b"]), snapshot("test", ["b", "a"]),
    ])).toEqual({ kind: "unchanged", repeated: ["a", "b"] });
  });

  it("evaluates stage advancement before a repeating fingerprint cycle", () => {
    expect(detectProgress([
      snapshot("test", ["a"]), snapshot("typecheck", ["b"]),
      snapshot("test", ["a"]), snapshot("typecheck", ["b"]),
    ])).toMatchObject({ kind: "improved" });
  });

  it("evaluates validator status improvement before oscillation", () => {
    const statusSnapshot = (status: ValidationResult["status"]): ProgressSnapshot => ({
      results: [result("test", status, ["a"])], diff: "same",
    });

    expect(detectProgress([
      statusSnapshot("infrastructure_error"), statusSnapshot("failed"),
      statusSnapshot("infrastructure_error"), statusSnapshot("failed"),
    ])).toMatchObject({ kind: "improved" });
  });

  it("evaluates de-duplicated severity improvement before oscillation", () => {
    const severitySnapshot = (severity: ValidationIssue["severity"], duplicates = 1): ProgressSnapshot => ({
      results: [{ ...result("test", "failed", []), issues: Array.from({ length: duplicates }, () => issue("a", severity)) }],
      diff: "same",
    });

    expect(detectProgress([
      severitySnapshot("error"), severitySnapshot("warning"),
      severitySnapshot("error", 2), severitySnapshot("warning", 3),
    ])).toMatchObject({ kind: "improved" });
  });

  it("normalizes volatile diff headers but distinguishes meaningful code changes", () => {
    const first = snapshot("test", ["a"], "index abc123..def456 100644\n@@ -1,2 +4,2 @@\n-const value = 0;\n+const value = 1;");
    const same = snapshot("test", ["a"], "index 111111..999999 100644\n@@ -90,2 +120,2 @@\n-const value = 0;\n+const value = 1;");
    const changed = snapshot("test", ["a"], "index 222222..888888 100644\n@@ -3 +7 @@\n-const value = 1;\n+const value = 2;");

    expect(detectProgress([first, same])).toMatchObject({ kind: "unchanged" });
    expect(detectProgress([first, same, changed]).kind).not.toBe("unchanged");
  });

  it("normalizes Windows and Unix temporary roots in diff file headers", () => {
    const windows = snapshot("test", ["a"], [
      "--- C:\\Users\\runner\\AppData\\Local\\Temp\\run-123\\packages\\pkg1\\src\\a.ts",
      "+++ C:\\Users\\runner\\AppData\\Local\\Temp\\run-123\\packages\\pkg1\\src\\a.ts",
      "+const value = 1;",
    ].join("\n"));
    const unix = snapshot("test", ["a"], [
      "--- /tmp/run-999/packages/pkg1/src/a.ts",
      "+++ /tmp/run-999/packages/pkg1/src/a.ts",
      "+const value = 1;",
    ].join("\n"));

    expect(detectProgress([windows, unix])).toMatchObject({ kind: "unchanged" });
  });
});

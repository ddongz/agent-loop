import { describe, expect, it } from "vitest";

import type { ValidationIssue, ValidationResult, ValidatorName } from "../../../src/domain/validation.js";
import { FeedbackEngine, type FeedbackHistoryEntry } from "../../../src/feedback/feedback-engine.js";

const now = (): string => "2026-08-14T00:00:00.000Z";
const issue = (fingerprint: string, message = fingerprint, category: ValidationIssue["category"] = "TEST_ASSERTION"): ValidationIssue => ({
  category, severity: "error", message, file: "tests/a.test.ts", line: 1, column: 2,
  rule: null, testName: "does a thing", fingerprint,
});
const result = (
  validator: ValidatorName,
  status: ValidationResult["status"],
  issues: ValidationIssue[] = [],
): ValidationResult => ({
  validator, status, exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
  command: { executable: "npm", args: ["test"] }, startedAt: now(), durationMs: 1, issues,
  stdoutSummary: "", stderrSummary: "", stdoutTruncated: false, stderrTruncated: false,
});
const entry = (fingerprints: string[], diff = "diff --git a/src/a.ts b/src/a.ts"): FeedbackHistoryEntry => ({
  results: [result("test", "failed", fingerprints.map((value) => issue(value)))], diff,
});

describe("FeedbackEngine", () => {
  it("requests the success gate when every enabled validator passed", () => {
    const feedback = new FeedbackEngine({ now, budget: { maxIterations: 8 } }).evaluate([
      result("test", "passed"), result("typecheck", "passed"), result("lint", "passed"), result("build", "passed"),
    ], [], "", { iterations: 3 });

    expect(feedback).toMatchObject({ decision: "REQUEST_SUCCESS_CHECK", currentStage: null, remainingIterations: 5 });
  });

  it("requires exactly one issue-free result for each authoritative enabled validator", () => {
    const all = [result("test", "passed"), result("typecheck", "passed"), result("lint", "passed"), result("build", "passed")];
    const enabledTestOnly = new FeedbackEngine({ now, enabledValidators: ["test"] });

    expect(new FeedbackEngine({ now }).evaluate(all.slice(0, 3), [], "").decision).not.toBe("REQUEST_SUCCESS_CHECK");
    expect(new FeedbackEngine({ now }).evaluate([...all, result("test", "passed")], [], "").decision).not.toBe("REQUEST_SUCCESS_CHECK");
    expect(enabledTestOnly.evaluate([result("test", "passed"), result("typecheck", "passed")], [], "").decision).not.toBe("REQUEST_SUCCESS_CHECK");
    expect(enabledTestOnly.evaluate([result("test", "passed", [issue("unexpected")])], [], "").decision).not.toBe("REQUEST_SUCCESS_CHECK");
    expect(enabledTestOnly.evaluate([result("test", "passed")], [], "").decision).toBe("REQUEST_SUCCESS_CHECK");
  });

  it("rejects an empty or duplicate enabled-validator configuration", () => {
    expect(() => new FeedbackEngine({ enabledValidators: [] })).toThrow(/enabled validator/i);
    expect(() => new FeedbackEngine({ enabledValidators: ["test", "test"] })).toThrow(/duplicate/i);
  });

  it("keeps infrastructure failure separate from actionable code feedback", () => {
    const feedback = new FeedbackEngine({ now }).evaluate([
      result("test", "infrastructure_error", [issue("infra", "spawn ENOENT", "INFRASTRUCTURE_ERROR")]),
    ], [], "", { iterations: 1 });

    expect(feedback.decision).toBe("FAIL_INFRASTRUCTURE");
    expect(feedback.summary).toContain("Infrastructure");
    expect(feedback.summary).not.toContain("fix the code");
  });

  it("emits deterministic resolved, new, repeated, category, and budget details", () => {
    const feedback = new FeedbackEngine({ now, budget: { maxIterations: 8 } }).evaluate([
      result("test", "failed", [issue("same"), issue("new", "expected 1 to be 2")]),
    ], [entry(["resolved", "same"])], "diff --git a/src/a.ts b/src/a.ts", { iterations: 2 });

    expect(feedback.decision).toBe("CONTINUE");
    expect(feedback.summary).toContain("resolved=resolved");
    expect(feedback.summary).toContain("new=new");
    expect(feedback.summary).toContain("repeated=same");
    expect(feedback.summary).toContain("categories=TEST_ASSERTION:2");
    expect(feedback.summary).toContain("iterations=2/8; remaining=6");
  });

  it("pauses exactly on the third unchanged fingerprint set", () => {
    const engine = new FeedbackEngine({ now });
    const current = [result("test", "failed", [issue("same")])];
    const unchangedDiff = "diff --git a/src/a.ts b/src/a.ts";

    expect(engine.evaluate(current, [entry(["same"])], unchangedDiff, { iterations: 2 }).decision).toBe("CONTINUE");
    expect(engine.evaluate(current, [entry(["same"]), entry(["same"])], unchangedDiff, { iterations: 3 })).toMatchObject({
      decision: "PAUSE_NO_PROGRESS", progress: { kind: "unchanged", repeated: ["same"] },
    });
  });

  it("pauses a stable length-2 or length-3 cycle", () => {
    const engine = new FeedbackEngine({ now });
    const unchangedDiff = "diff --git a/src/a.ts b/src/a.ts";
    expect(engine.evaluate([result("test", "failed", [issue("b")])], [entry(["a"]), entry(["b"]), entry(["a"])], unchangedDiff, { iterations: 4 })).toMatchObject({
      decision: "PAUSE_NO_PROGRESS", progress: { kind: "oscillating", cycleLength: 2 },
    });
    expect(engine.evaluate([result("test", "failed", [issue("c")])], [
      entry(["a"]), entry(["b"]), entry(["c"]), entry(["a"]), entry(["b"]),
    ], unchangedDiff, { iterations: 6 })).toMatchObject({
      decision: "PAUSE_NO_PROGRESS", progress: { kind: "oscillating", cycleLength: 3 },
    });
  });

  it("uses stable infrastructure, success, budget, then stall decision priority", () => {
    const exhausted = new FeedbackEngine({ now, enabledValidators: ["test"], budget: { maxIterations: 1, maxDurationMs: 10, maxTokens: 10, maxCostUsd: 1 } });
    const usage = { iterations: 1, elapsedMs: 10, inputTokens: 10, outputTokens: 0, costUsd: 1 };

    expect(exhausted.evaluate([result("test", "infrastructure_error", [issue("infra", "ENOENT", "INFRASTRUCTURE_ERROR")])], [], "", usage).decision).toBe("FAIL_INFRASTRUCTURE");
    expect(exhausted.evaluate([result("test", "passed")], [], "", usage).decision).toBe("REQUEST_SUCCESS_CHECK");
    expect(exhausted.evaluate([result("test", "failed", [issue("a")])], [], "", usage).decision).toBe("PAUSE_BUDGET");
  });

  it.each([
    [{ maxDurationMs: 100 }, { iterations: 1, elapsedMs: 100 }],
    [{ maxTokens: 100 }, { iterations: 1, inputTokens: 60, outputTokens: 40 }],
    [{ maxCostUsd: 1 }, { iterations: 1, costUsd: 1 }],
  ] as const)("pauses at each non-iteration budget boundary", (budget, usage) => {
    const engine = new FeedbackEngine({ now, budget: { maxIterations: 8, ...budget } });

    expect(engine.evaluate([result("test", "failed", [issue("a")])], [], "", usage).decision).toBe("PAUSE_BUDGET");
  });

  it("does not pause immediately below every budget boundary", () => {
    const engine = new FeedbackEngine({
      now,
      budget: { maxIterations: 8, maxDurationMs: 100, maxTokens: 100, maxCostUsd: 1 },
    });

    expect(engine.evaluate([result("test", "failed", [issue("a")])], [], "", {
      iterations: 7, elapsedMs: 99, inputTokens: 60, outputTokens: 39, costUsd: 0.99,
    }).decision).toBe("CONTINUE");
  });

  it("caps feedback at 8 KiB and redacts secret-like values in summaries and issues", () => {
    const secrets = [
      "sk-live-abcdef1234567890",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123456",
    ];
    const feedback = new FeedbackEngine({ now }).evaluate([
      result("test", "failed", Array.from({ length: 200 }, (_, index) => issue(
        `fp-${index.toString().padStart(3, "0")}`,
        `${secrets[index % secrets.length]} ${"x".repeat(100)}`,
      ))),
    ], [], "", { iterations: 1 });

    expect(Buffer.byteLength(feedback.summary, "utf8")).toBeLessThanOrEqual(8_192);
    for (const secret of secrets) expect(JSON.stringify(feedback)).not.toContain(secret);
    expect(feedback.summary).toContain("[REDACTED]");
    expect(feedback.issues.length).toBeLessThanOrEqual(100);
    expect(feedback.summary).not.toContain("fp-199");
  });

  it("does not pause when the failure is stable but each round has a meaningful code diff", () => {
    const engine = new FeedbackEngine({ now });
    const current = [result("test", "failed", [issue("same")])];

    expect(engine.evaluate(current, [
      entry(["same"], "-const value = 0;\n+const value = 1;"),
      entry(["same"], "-const value = 1;\n+const value = 2;"),
    ], "-const value = 2;\n+const value = 3;", { iterations: 3 }).decision).toBe("CONTINUE");
  });
});

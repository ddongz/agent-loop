import { describe, expect, it } from "vitest";

import { ActionSchema } from "../../../src/domain/action.js";
import { SentinelError, SerializedSentinelErrorSchema } from "../../../src/domain/error.js";
import { BudgetSchema, TaskEventSchema, TaskStateSchema, TestBaselineSchema } from "../../../src/domain/task.js";

const now = "2026-08-14T00:00:00.000Z";
const sha = "a".repeat(64);

function successfulTask() {
  return {
    schemaVersion: 1, id: "t1", repositoryRoot: "C:/repo", requirement: "Implement contracts.", phase: "SUCCEEDED", resumePhase: null, iteration: 1,
    budget: { maxIterations: 8, maxDurationMs: 1_800_000, maxTokens: null, maxCostUsd: null },
    usage: { iterations: 1, elapsedMs: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    validationPlan: [{ validator: "test", executable: "npm", args: ["test"], timeoutMs: 1_000, enabled: true }],
    protectedTests: [], baselineVersion: 0, pendingApproval: null, lastFeedback: null, lastError: null,
    lastCodeChangeAt: "2026-08-13T23:59:59.000Z", finalValidationAt: now,
    finalValidation: { results: [{ validator: "test", status: "passed", exitCode: 0, command: { executable: "npm", args: ["test"] }, startedAt: now, durationMs: 0, issues: [], stdoutSummary: "", stderrSummary: "", stdoutTruncated: false, stderrTruncated: false }], baselineVerified: true, workspacePolicyVerified: true, codeVersion: sha, completedAt: now },
    createdAt: now, updatedAt: now
  };
}

describe("domain contracts", () => {
  it("rejects unknown action fields", () => {
    expect(ActionSchema.safeParse({ version: 1, id: "a1", rationale: "x", type: "finish", summary: "done", extra: true }).success).toBe(false);
  });

  it("provides specified action defaults", () => {
    expect(ActionSchema.parse({ version: 1, id: "a1", rationale: "Inspect.", type: "read_file", path: "src/index.ts" }).maxBytes).toBe(65_536);
  });

  it("rejects patch headers that do not describe exactly the action path", () => {
    expect(ActionSchema.safeParse({ version: 1, id: "a1", rationale: "Patch.", type: "apply_patch", path: "src/a.ts", patch: "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-a\n+b" }).success).toBe(false);
  });

  it("accepts bare-hunk patches and Claude-style whole-file blocks", () => {
    const bare = { version: 1, id: "a1", rationale: "Patch.", type: "apply_patch", path: "src/a.ts", patch: "@@\n-old\n+new" };
    expect(ActionSchema.safeParse(bare).success).toBe(true);
    const claude = {
      version: 1, id: "a2", rationale: "Rewrite.", type: "apply_patch", path: "src/a.ts",
      patch: "*** Begin Patch\n*** Update File: src/a.ts\nnew\n*** End Patch",
    };
    expect(ActionSchema.safeParse(claude).success).toBe(true);
    const mismatchedBlock = {
      version: 1, id: "a3", rationale: "Rewrite.", type: "apply_patch", path: "src/a.ts",
      patch: "*** Begin Patch\n*** Update File: src/other.ts\nnew\n*** End Patch",
    };
    expect(ActionSchema.safeParse(mismatchedBlock).success).toBe(false);
  });

  it("accepts a fully valid succeeded task", () => {
    expect(TaskStateSchema.safeParse(successfulTask()).success).toBe(true);
  });

  it("rejects succeeded task snapshots with missing, duplicate, disabled, or failed validators", () => {
    for (const mutate of [
      (task: ReturnType<typeof successfulTask>) => { task.finalValidation = null; },
      (task: ReturnType<typeof successfulTask>) => { task.finalValidation!.results.push(task.finalValidation!.results[0]!); },
      (task: ReturnType<typeof successfulTask>) => { task.validationPlan[0]!.enabled = false; },
      (task: ReturnType<typeof successfulTask>) => { task.finalValidation!.results[0]!.status = "failed"; }
    ]) {
      const task = successfulTask(); mutate(task); expect(TaskStateSchema.safeParse(task).success).toBe(false);
    }
  });

  it("compares success timestamps as instants", () => {
    const task = successfulTask(); task.lastCodeChangeAt = "2026-08-14T00:00:00.000Z"; task.finalValidationAt = "2026-08-13T20:00:00.000-05:00"; task.finalValidation!.completedAt = task.finalValidationAt;
    expect(TaskStateSchema.safeParse(task).success).toBe(true);
  });

  it("requires integer token budgets", () => {
    expect(BudgetSchema.safeParse({ maxIterations: 8, maxDurationMs: 1_000, maxTokens: 1.5, maxCostUsd: null }).success).toBe(false);
  });

  it("rejects non-JSON error details", () => {
    expect(SerializedSentinelErrorSchema.safeParse({ code: "INTERNAL", message: "x", retryable: false, recoverable: false, detail: { nested: new Date() } }).success).toBe(false);
  });

  it("accepts strict event and baseline contracts", () => {
    expect(TaskEventSchema.safeParse({ schemaVersion: 1, id: "e1", taskId: "t1", sequence: 1, type: "TASK_CREATED", timestamp: now, phaseBefore: null, phaseAfter: "PRECHECK", actionId: null, observationActionId: null, causationEventId: null, payload: { ok: [true, null] } }).success).toBe(true);
    expect(TestBaselineSchema.safeParse({ schemaVersion: 1, currentVersion: 1, versions: [{ version: 1, protectedTests: [{ path: "tests/a.test.ts", sha256: sha, frozenAt: now }], frozenDiff: "", confirmedAt: now, approval: null }] }).success).toBe(true);
  });

  it("rejects unknown event fields and invalid baseline hashes", () => {
    expect(TaskEventSchema.safeParse({ schemaVersion: 1, id: "e1", taskId: "t1", sequence: 1, type: "TASK_CREATED", timestamp: now, phaseBefore: null, phaseAfter: "PRECHECK", actionId: null, observationActionId: null, causationEventId: null, payload: {}, extra: true }).success).toBe(false);
    expect(TestBaselineSchema.safeParse({ schemaVersion: 1, currentVersion: 1, versions: [{ version: 1, protectedTests: [{ path: "tests/a.test.ts", sha256: "bad", frozenAt: now }], frozenDiff: "", confirmedAt: now, approval: null }] }).success).toBe(false);
  });

  it("serializes errors after redacting message and detail", () => {
    const error = new SentinelError({ code: "LLM_AUTH", message: "secret-token", detail: { token: "secret-token" } });
    expect(error.toJSON((value) => typeof value === "string" ? "[REDACTED]" : { token: "[REDACTED]" })).toMatchObject({ code: "LLM_AUTH", message: "[REDACTED]", retryable: false, recoverable: true, detail: { token: "[REDACTED]" } });
  });
});

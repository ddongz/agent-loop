import { describe, expect, it } from "vitest";

import { TaskEventSchema, TaskStateSchema, type TaskEvent } from "../../../src/domain/task.js";
import { generateReport } from "../../../src/reporting/report-generator.js";

const timestamp = "2026-08-14T08:00:00.000Z";
const hash = "a".repeat(64);

function task() {
  return TaskStateSchema.parse({
    schemaVersion: 1,
    id: "task-9",
    repositoryRoot: "/repo",
    requirement: "Add an audited command",
    phase: "PAUSED",
    resumePhase: "IMPLEMENT",
    iteration: 2,
    budget: { maxIterations: 8, maxDurationMs: 1_800_000, maxTokens: null, maxCostUsd: null },
    usage: { iterations: 2, elapsedMs: 4_000, inputTokens: 30, outputTokens: 20, costUsd: null },
    validationPlan: [{ validator: "test", executable: "npm", args: ["test"], timeoutMs: 10_000, enabled: true }],
    protectedTests: [{ path: "tests/feature.test.ts", sha256: hash, frozenAt: timestamp }],
    baselineVersion: 1,
    pendingApproval: null,
    lastFeedback: null,
    lastError: null,
    lastCodeChangeAt: timestamp,
    finalValidationAt: null,
    finalValidation: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function event(sequence: number, type: TaskEvent["type"], payload: TaskEvent["payload"]): TaskEvent {
  return TaskEventSchema.parse({
    schemaVersion: 1,
    id: `event-${sequence}`,
    taskId: "task-9",
    sequence,
    type,
    timestamp,
    phaseBefore: type === "TASK_CREATED" ? null : "IMPLEMENT",
    phaseAfter: type === "TASK_CREATED" ? "PRECHECK" : "IMPLEMENT",
    actionId: ["ACTION_REQUESTED", "POLICY_DECIDED", "ACTION_COMPLETED", "APPROVAL_REQUESTED", "APPROVAL_RESOLVED"].includes(type) ? "action-1" : null,
    observationActionId: null,
    causationEventId: null,
    payload,
  });
}

describe("Markdown report", () => {
  it("deterministically includes the required audit sections", () => {
    const events = [
      event(1, "TASK_CREATED", {}),
      event(2, "ACTION_REQUESTED", { action: { type: "create_file", path: "src/a.ts" } }),
      event(3, "POLICY_DECIDED", { effect: "ALLOW", reason: "inside workspace" }),
      event(4, "FEEDBACK_CREATED", { summary: "one assertion remains" }),
      event(5, "APPROVAL_REQUESTED", { reason: "protected test mutation" }),
    ];

    const first = generateReport(task(), events);
    const second = generateReport(task(), events);

    expect(first).toBe(second);
    expect(first).toContain("# SentinelLoop Task Report");
    expect(first).toContain("Add an audited command");
    expect(first).toContain(hash);
    expect(first).toMatch(/Phase History|Actions|Policy Decisions|Feedback|Approvals|Budget|Final Validation/);
  });

  it("redacts exact secrets and pattern-shaped tokens before serializing nested events", () => {
    const secret = "opaque-value-4nY7q";
    const events = [event(1, "TASK_CREATED", {
      nested: { message: `backend said ${secret}`, values: [`Bearer sk-test-1234567890abcdef`] },
    })];

    const report = generateReport(task(), events, { sensitiveValues: [secret] });

    expect(report).not.toContain(secret);
    expect(report).not.toContain("sk-test-1234567890abcdef");
    expect(report).toContain("[REDACTED]");
  });
});

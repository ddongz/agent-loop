import { describe, expect, it } from "vitest";

import { TaskEventSchema, TaskStateSchema, type TaskEvent, type TaskState } from "../../../src/domain/task.js";
import type { Feedback } from "../../../src/domain/validation.js";
import { buildContext, CONTEXT_SECTION_LIMITS } from "../../../src/llm/context-builder.js";

const secret = "opaque-credential-ABCDEFGHIJKLMN";

function task(): TaskState {
  return TaskStateSchema.parse({
    schemaVersion: 1,
    id: "task-7",
    repositoryRoot: "C:/repo",
    requirement: `Add email lookup without exposing ${secret}`,
    phase: "IMPLEMENT",
    resumePhase: null,
    iteration: 3,
    budget: { maxIterations: 8, maxDurationMs: 60_000, maxTokens: 4_000, maxCostUsd: null },
    usage: { iterations: 3, elapsedMs: 2_000, inputTokens: 300, outputTokens: 80, costUsd: null },
    validationPlan: [],
    protectedTests: [],
    baselineVersion: 0,
    pendingApproval: null,
    lastFeedback: null,
    lastError: null,
    lastCodeChangeAt: null,
    finalValidationAt: null,
    finalValidation: null,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:03.000Z"
  });
}

function event(sequence: number, type: TaskEvent["type"], payload: Record<string, string>): TaskEvent {
  return TaskEventSchema.parse({
    schemaVersion: 1,
    id: `event-${sequence}`,
    taskId: "task-7",
    sequence,
    type,
    timestamp: `2026-08-14T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    phaseBefore: "IMPLEMENT",
    phaseAfter: "IMPLEMENT",
    actionId: type.startsWith("ACTION_") ? `action-${sequence}` : null,
    observationActionId: type === "ACTION_COMPLETED" ? `action-${sequence}` : null,
    causationEventId: null,
    payload
  });
}

function feedback(): Feedback {
  return {
    decision: "CONTINUE",
    summary: `Repair assertion; diagnostic token=${secret}`,
    currentStage: "test",
    progress: { kind: "improved", resolved: ["fp-old"], introduced: ["fp-new"] },
    issues: [{
      category: "TEST_ASSERTION",
      severity: "error",
      message: `expected lookup; Authorization: Bearer ${secret}`,
      file: "tests/user.test.ts",
      line: 10,
      column: 3,
      rule: null,
      testName: "finds by email",
      fingerprint: "fp-new"
    }],
    remainingIterations: 5,
    createdAt: "2026-08-14T00:00:03.000Z"
  };
}

describe("buildContext", () => {
  it("keeps current causal context and removes old unrelated history and secrets", () => {
    const events = [
      event(1, "TASK_CREATED", { note: `old unrelated ${secret}` }),
      event(2, "ACTION_COMPLETED", { output: `read ${secret}` }),
      event(3, "FEEDBACK_CREATED", { fingerprint: "fp-new", secret })
    ];

    const request = buildContext(task(), events, feedback(), {
      systemGovernance: `Never reveal ${secret}; use one tool.`,
      repositorySummary: `src/user.ts contains ${secret}`,
      tools: [{ name: "read_file", description: "Read a bounded file.", inputSchema: { type: "object" } }],
      observations: [{ actionId: "read-1", tool: "read_file", status: "succeeded", output: `content ${secret}`, truncated: false }],
      sensitiveValues: [secret]
    });
    const serialized = JSON.stringify(request);

    expect(request).toMatchObject({
      phase: "IMPLEMENT",
      context: {
        current: { iteration: 3, budget: { maxIterations: 8 }, usage: { iterations: 3 } },
        feedback: { issueFingerprints: ["fp-new"], remainingIterations: 5 },
        events: [{ sequence: 2 }, { sequence: 3 }]
      },
      tools: [{ name: "read_file" }]
    });
    expect(request.context.requirement).toContain("Add email lookup");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("old unrelated");
  });

  it("selects recent relevant events deterministically by sequence", () => {
    const events = Array.from({ length: 20 }, (_, index) => event(20 - index, "ACTION_COMPLETED", { value: String(20 - index) }));
    const options = {
      systemGovernance: "Use governed tools.",
      repositorySummary: "repository",
      tools: [{ name: "read_file", description: "Read.", inputSchema: { type: "object" } }]
    };

    const first = buildContext(task(), events, null, options);
    const second = buildContext(task(), [...events].reverse(), null, options);

    expect(first.context.events).toEqual(second.context.events);
    expect(first.context.events.map(({ sequence }) => sequence)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
  });

  it("caps UTF-8 sections by encoded bytes without splitting surrogate pairs", () => {
    const request = buildContext(
      TaskStateSchema.parse({ ...task(), requirement: "界".repeat(10_000) }),
      [],
      null,
      {
        systemGovernance: "规".repeat(10_000),
        repositorySummary: "库".repeat(10_000),
        tools: [{ name: "read_file", description: "Read.", inputSchema: { type: "object" } }]
      }
    );
    const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

    expect(bytes(request.context.requirement)).toBeLessThanOrEqual(CONTEXT_SECTION_LIMITS.requirementBytes);
    expect(bytes(request.context.systemGovernance)).toBeLessThanOrEqual(CONTEXT_SECTION_LIMITS.systemBytes);
    expect(bytes(request.context.repositorySummary)).toBeLessThanOrEqual(CONTEXT_SECTION_LIMITS.repositoryBytes);
    expect(request.context.requirement.endsWith("�")).toBe(false);
  });
});

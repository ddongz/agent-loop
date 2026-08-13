import { describe, expect, it } from "vitest";

import { SentinelError } from "../../../src/domain/error.js";
import { TaskStateSchema, type TaskPhase, type TaskState } from "../../../src/domain/task.js";
import { canTransition, transition } from "../../../src/state/transition-table.js";

const CREATED_AT = "2026-08-14T00:00:00.000Z";
const UPDATED_AT = "2026-08-14T00:01:00.000Z";
const NEXT_AT = "2026-08-14T00:02:00.000Z";

function makeState(phase: TaskPhase, overrides: Partial<TaskState> = {}): TaskState {
  const succeededEvidence = phase === "SUCCEEDED" ? {
    finalValidationAt: UPDATED_AT,
    finalValidation: {
      results: [],
      baselineVerified: true,
      workspacePolicyVerified: true,
      codeVersion: "a".repeat(64),
      completedAt: UPDATED_AT
    }
  } : {};
  return TaskStateSchema.parse({
    schemaVersion: 1,
    id: "t1",
    repositoryRoot: "C:/repository",
    requirement: "Implement the requested behavior",
    phase,
    resumePhase: null,
    iteration: 0,
    budget: {
      maxIterations: 8,
      maxDurationMs: 1_800_000,
      maxTokens: null,
      maxCostUsd: null
    },
    usage: {
      iterations: 0,
      elapsedMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null
    },
    validationPlan: [],
    protectedTests: [],
    baselineVersion: 0,
    pendingApproval: null,
    lastFeedback: null,
    lastError: null,
    lastCodeChangeAt: null,
    finalValidationAt: null,
    finalValidation: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...succeededEvidence,
    ...overrides
  });
}

describe("transition table", () => {
  it("allows only declared transitions after applying their dynamic guards", () => {
    const allowed: Record<TaskPhase, TaskPhase[]> = {
      PRECHECK: ["ANALYZE_REQUIREMENT", "FAILED"],
      ANALYZE_REQUIREMENT: ["GENERATE_TESTS", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
      GENERATE_TESTS: ["CONFIRM_RED", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
      CONFIRM_RED: ["FREEZE_TESTS", "GENERATE_TESTS", "PAUSED", "FAILED"],
      FREEZE_TESTS: ["IMPLEMENT", "FAILED"],
      IMPLEMENT: ["VALIDATE", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
      VALIDATE: ["FEEDBACK", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
      FEEDBACK: ["IMPLEMENT", "PAUSED", "FAILED"],
      AWAITING_APPROVAL: ["PAUSED", "FAILED"],
      PAUSED: ["PRECHECK"],
      SUCCEEDED: [],
      FAILED: []
    };
    const phases = Object.keys(allowed) as TaskPhase[];

    for (const from of phases) {
      const supportsApproval = ["ANALYZE_REQUIREMENT", "GENERATE_TESTS", "IMPLEMENT", "VALIDATE"].includes(from);
      const approvalResumePhase = from === "AWAITING_APPROVAL" ? "IMPLEMENT" : from;
      const state = makeState(from, from === "AWAITING_APPROVAL" || supportsApproval ? {
        pendingApproval: {
          action: { version: 1, id: "a1", rationale: "Needs approval", type: "create_file", path: "src/new.ts", content: "" },
          decisionReason: "Creates a file",
          requestedAt: UPDATED_AT,
          resumePhase: approvalResumePhase,
          baselineVersion: 0
        },
        resumePhase: from === "AWAITING_APPROVAL" ? "IMPLEMENT" : null
      } : {});
      for (const to of phases) {
        const dynamicallyAllowed = from === "AWAITING_APPROVAL" && to === "IMPLEMENT";
        expect(canTransition(state, to), `${from} -> ${to}`).toBe(allowed[from].includes(to) || dynamicallyAllowed);
      }
    }
  });

  it("uses the saved resume phase for precheck recovery and consumes it", () => {
    const state = makeState("PRECHECK", { resumePhase: "VALIDATE" });

    expect(canTransition(state, "ANALYZE_REQUIREMENT")).toBe(false);
    expect(canTransition(state, "VALIDATE")).toBe(true);
    expect(transition(state, "VALIDATE", NEXT_AT)).toMatchObject({
      phase: "VALIDATE",
      resumePhase: null,
      updatedAt: NEXT_AT
    });
  });

  it("requires approval context and clears it after approval", () => {
    const withoutApproval = makeState("AWAITING_APPROVAL", { resumePhase: "IMPLEMENT" });
    const withApproval = makeState("AWAITING_APPROVAL", {
      resumePhase: "IMPLEMENT",
      pendingApproval: {
        action: { version: 1, id: "a1", rationale: "Needs approval", type: "create_file", path: "src/new.ts", content: "" },
        decisionReason: "Creates a file",
        requestedAt: UPDATED_AT,
        resumePhase: "IMPLEMENT",
        baselineVersion: 0
      }
    });

    expect(canTransition(withoutApproval, "IMPLEMENT")).toBe(false);
    expect(canTransition(withApproval, "VALIDATE")).toBe(false);
    expect(transition(withApproval, "IMPLEMENT", NEXT_AT)).toMatchObject({
      phase: "IMPLEMENT",
      pendingApproval: null,
      updatedAt: NEXT_AT
    });
  });

  it("can pause while awaiting approval without losing the active resume phase", () => {
    const awaiting = makeState("AWAITING_APPROVAL", {
      resumePhase: "IMPLEMENT",
      pendingApproval: {
        action: { version: 1, id: "a1", rationale: "Needs approval", type: "create_file", path: "src/new.ts", content: "" },
        decisionReason: "Creates a file",
        requestedAt: UPDATED_AT,
        resumePhase: "IMPLEMENT",
        baselineVersion: 0
      }
    });

    expect(transition(awaiting, "PAUSED", NEXT_AT)).toMatchObject({
      phase: "PAUSED",
      resumePhase: "IMPLEMENT",
      pendingApproval: null,
      updatedAt: NEXT_AT
    });
  });

  it("preserves an active resume phase when entering paused or approval states", () => {
    const paused = transition(makeState("IMPLEMENT"), "PAUSED", NEXT_AT);
    const awaiting = transition(makeState("IMPLEMENT", {
      pendingApproval: {
        action: { version: 1, id: "a1", rationale: "Needs approval", type: "create_file", path: "src/new.ts", content: "" },
        decisionReason: "Creates a file",
        requestedAt: UPDATED_AT,
        resumePhase: "IMPLEMENT",
        baselineVersion: 0
      }
    }), "AWAITING_APPROVAL", NEXT_AT);

    expect(paused.resumePhase).toBe("IMPLEMENT");
    expect(awaiting.resumePhase).toBe("IMPLEMENT");
  });

  it("rejects approval context for a different phase or baseline", () => {
    const mismatches = [
      { resumePhase: "VALIDATE" as const, baselineVersion: 0 },
      { resumePhase: "IMPLEMENT" as const, baselineVersion: 1 }
    ];

    for (const approval of mismatches) {
      const state = makeState("IMPLEMENT", {
        pendingApproval: {
          action: { version: 1, id: "a1", rationale: "Needs approval", type: "create_file", path: "src/new.ts", content: "" },
          decisionReason: "Creates a file",
          requestedAt: UPDATED_AT,
          ...approval
        }
      });

      expect(canTransition(state, "AWAITING_APPROVAL")).toBe(false);
      expect(() => transition(state, "AWAITING_APPROVAL", NEXT_AT)).toThrowError(
        expect.objectContaining<Partial<SentinelError>>({ code: "INVALID_TRANSITION" })
      );
    }
  });

  it("rejects success until the final evidence satisfies the task schema", () => {
    const incomplete = makeState("VALIDATE");
    const completedAt = "2026-08-14T00:03:00.000Z";
    const validated = makeState("VALIDATE", {
      finalValidationAt: completedAt,
      finalValidation: {
        results: [],
        baselineVerified: true,
        workspacePolicyVerified: true,
        codeVersion: "a".repeat(64),
        completedAt
      }
    });

    expect(canTransition(incomplete, "SUCCEEDED")).toBe(false);
    expect(canTransition(validated, "SUCCEEDED")).toBe(true);
    expect(transition(validated, "SUCCEEDED", NEXT_AT)).toMatchObject({
      phase: "SUCCEEDED",
      resumePhase: null,
      updatedAt: NEXT_AT
    });
  });

  it("uses the same success guard when stale approval context remains", () => {
    const completedAt = "2026-08-14T00:03:00.000Z";
    const pendingApproval = {
      action: { version: 1 as const, id: "a1", rationale: "Needs approval", type: "create_file" as const, path: "src/new.ts", content: "" },
      decisionReason: "Creates a file",
      requestedAt: UPDATED_AT,
      resumePhase: "IMPLEMENT" as const,
      baselineVersion: 0
    };
    const stale = makeState("VALIDATE", {
      pendingApproval,
      finalValidationAt: completedAt,
      finalValidation: {
        results: [],
        baselineVerified: true,
        workspacePolicyVerified: true,
        codeVersion: "a".repeat(64),
        completedAt
      }
    });

    expect(canTransition(stale, "SUCCEEDED")).toBe(false);
    expect(() => transition(stale, "SUCCEEDED", NEXT_AT)).toThrowError(
      expect.objectContaining<Partial<SentinelError>>({ code: "INVALID_TRANSITION" })
    );
  });

  it("rejects invalid or regressing transition timestamps with INVALID_TRANSITION", () => {
    const state = makeState("PRECHECK");

    for (const now of ["not-a-time", CREATED_AT]) {
      expect(() => transition(state, "ANALYZE_REQUIREMENT", now)).toThrowError(
        expect.objectContaining<Partial<SentinelError>>({ code: "INVALID_TRANSITION" })
      );
    }
  });

  it("throws INVALID_TRANSITION without mutating state", () => {
    const state = makeState("GENERATE_TESTS");

    expect(() => transition(state, "IMPLEMENT", NEXT_AT)).toThrowError(
      expect.objectContaining<Partial<SentinelError>>({ code: "INVALID_TRANSITION" })
    );
    expect(state).toEqual(makeState("GENERATE_TESTS"));
  });
});

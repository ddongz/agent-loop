import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ValidationResult } from "../../../src/domain/validation.js";
import { FeedbackEngine } from "../../../src/feedback/feedback-engine.js";
import { ApprovalManager } from "../../../src/governance/approval.js";
import { PolicyEngine } from "../../../src/governance/policy-engine.js";
import { ScriptedLLMClient, type ScriptedStep } from "../../../src/llm/scripted-client.js";
import type { LLMClient } from "../../../src/llm/types.js";
import { TaskOrchestrator } from "../../../src/orchestrator/task-orchestrator.js";
import { EventStore } from "../../../src/state/event-store.js";
import { TaskStore } from "../../../src/state/task-store.js";
import { createFileTools } from "../../../src/tools/file-tools.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import {
  FakeWorkspaceInspector,
  MemoryBaselineService,
  SequenceClock,
  repositoryProfile,
  validationResult,
  validationTool,
} from "../../helpers/fakes.js";
import { createTempRepository } from "../../helpers/temp-repository.js";

describe("TaskOrchestrator deterministic pause and resume", () => {
  it("pauses after three unchanged signatures and reloads through PRECHECK without losing state", async () => {
    const fixture = await scenario([
      validationResult("failed", "same"),
      validationResult("failed", "same"),
      validationResult("failed", "same"),
    ]);

    const paused = await runUntilPaused(fixture.orchestrator, fixture.taskId);
    expect(paused).toMatchObject({
      phase: "PAUSED",
      resumePhase: "FEEDBACK",
      iteration: 3,
      usage: { iterations: 3 },
      lastFeedback: { decision: "PAUSE_NO_PROGRESS", progress: { kind: "unchanged" } },
    });

    let prechecks = 0;
    const reloaded = fixture.makeOrchestrator(async () => {
      prechecks += 1;
      return repositoryProfile(fixture.root);
    }, []);
    const resumed = await reloaded.resume(paused.id);
    expect(resumed).toMatchObject({ phase: "FEEDBACK", resumePhase: null, iteration: 3, usage: { iterations: 3 } });
    expect(prechecks).toBe(1);
    const events = await fixture.eventStore.list(paused.id);
    expect(events.map(({ sequence }) => sequence)).toEqual(events.map((_, index) => index + 1));
    const pauseEvent = events.findLast(({ type }) => type === "TASK_PAUSED");
    expect(events.at(-1)).toMatchObject({
      type: "TASK_RESUMED",
      phaseBefore: "PRECHECK",
      phaseAfter: "FEEDBACK",
      causationEventId: pauseEvent?.id,
    });
  });

  it("pauses on a true two-state failure-set cycle", async () => {
    const fixture = await scenario([
      validationResult("failed", "cycle-a"),
      validationResult("failed", "cycle-b"),
      validationResult("failed", "cycle-a"),
      validationResult("failed", "cycle-b"),
    ]);

    const paused = await runUntilPaused(fixture.orchestrator, fixture.taskId);
    expect(paused).toMatchObject({
      phase: "PAUSED",
      iteration: 4,
      lastFeedback: {
        decision: "PAUSE_NO_PROGRESS",
        progress: { kind: "oscillating", cycleLength: 2 },
      },
    });
  });

  it("persists an interrupted active phase for deterministic recovery", async () => {
    const fixture = await scenario([]);
    let state = await fixture.orchestrator.step(fixture.taskId);
    state = await fixture.orchestrator.step(state.id);
    state = await fixture.orchestrator.step(state.id);
    expect(state.phase).toBe("IMPLEMENT");
    const interrupted = fixture.makeOrchestrator(
      async () => repositoryProfile(fixture.root),
      [],
      { complete: async () => { throw new DOMException("interrupted", "AbortError"); } },
    );

    state = await interrupted.step(state.id);
    expect(state).toMatchObject({ phase: "PAUSED", resumePhase: "IMPLEMENT" });
    const events = await fixture.eventStore.list(state.id);
    expect(events.some(({ type }) => type === "USER_INTERRUPTED")).toBe(true);
  });

  it("restores approval in a fresh instance, executes the persisted action once and advances the baseline", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src", "feature.ts"), "export const value = 0;\n", "utf8");
    const clock = new SequenceClock();
    const workspace = new FakeWorkspaceInspector();
    const originalBaseline = new MemoryBaselineService();
    const taskStore = new TaskStore(root);
    const eventStore = new EventStore(root);
    const approvals = new ApprovalManager(clock.now);
    const protectedPatch = {
      version: 1 as const,
      id: "approved-test-patch",
      type: "apply_patch" as const,
      rationale: "Update the protected expectation.",
      path: "tests/feature.test.ts",
      patch: "--- a/tests/feature.test.ts\n+++ b/tests/feature.test.ts\n@@ -1 +1 @@\n-expect(value).toBe(2);\n+expect(value).toBe(3);\n",
    };
    const scripts: ScriptedStep[] = [
      { when: { call: 1, phase: "GENERATE_TESTS" }, action: { version: 1, id: "test", type: "create_file", rationale: "Add target test.", path: "tests/feature.test.ts", content: "expect(value).toBe(2);\n" } },
      { when: { call: 2, phase: "GENERATE_TESTS" }, action: { version: 1, id: "red", type: "run_validation", rationale: "Confirm red.", validator: "test" } },
      { when: { call: 3, phase: "IMPLEMENT" }, action: protectedPatch },
    ];
    const initialPolicy = new PolicyEngine();
    const initial = new TaskOrchestrator({
      taskStore,
      eventStore,
      precheck: async () => repositoryProfile(root),
      baseline: originalBaseline,
      policy: initialPolicy,
      registry: new ToolRegistry(initialPolicy, [...createFileTools({ workspaceRoot: root }), validationTool([[validationResult("failed", "red")]])]),
      feedback: new FeedbackEngine({ now: clock.now, enabledValidators: ["test"] }),
      llm: new ScriptedLLMClient(scripts),
      confirmation: { confirmRed: async () => true },
      workspace,
      approvals,
      now: clock.now,
    });
    let state = await initial.start({ id: "approval-recovery", repositoryRoot: root, requirement: "Implement feature." });
    for (let index = 0; index < 4; index += 1) state = await initial.step(state.id);
    expect(state).toMatchObject({ phase: "AWAITING_APPROVAL", baselineVersion: 1, pendingApproval: { action: protectedPatch } });

    const restoredBaseline = new MemoryBaselineService({ [state.id]: originalBaseline.snapshot(state.id) });
    const restoredApprovals = new ApprovalManager(clock.now);
    const restoredPolicy = new PolicyEngine();
    const restored = new TaskOrchestrator({
      taskStore: new TaskStore(root),
      eventStore: new EventStore(root),
      precheck: async () => repositoryProfile(root),
      baseline: restoredBaseline,
      policy: restoredPolicy,
      registry: new ToolRegistry(restoredPolicy, createFileTools({ workspaceRoot: root })),
      feedback: new FeedbackEngine({ now: clock.now, enabledValidators: ["test"] }),
      llm: new ScriptedLLMClient([]),
      confirmation: { confirmRed: async () => false },
      workspace,
      approvals: restoredApprovals,
      now: clock.now,
    });

    state = await restored.resume(state.id, { approved: true });
    expect(state).toMatchObject({ phase: "IMPLEMENT", pendingApproval: null, baselineVersion: 2 });
    expect(await readFile(join(root, "tests", "feature.test.ts"), "utf8")).toBe("expect(value).toBe(3);\n");
    await expect(restoredBaseline.verify(state.id, { root, testPaths: workspace.testPaths, baselineVersion: 2 }))
      .resolves.toMatchObject({ matches: true });
    const completions = (await eventStore.list(state.id)).filter((event) => event.type === "ACTION_COMPLETED" && event.actionId === protectedPatch.id);
    expect(completions.filter((event) => JSON.stringify(event.payload).includes('"status":"succeeded"'))).toHaveLength(1);
    const events = await eventStore.list(state.id);
    const approvalRequest = events.find((event) => event.type === "APPROVAL_REQUESTED" && event.actionId === protectedPatch.id);
    const approvalResolved = events.find((event) => event.type === "APPROVAL_RESOLVED" && event.actionId === protectedPatch.id);
    expect(approvalResolved).toMatchObject({
      phaseBefore: "AWAITING_APPROVAL",
      phaseAfter: "IMPLEMENT",
      causationEventId: approvalRequest?.id,
    });
    expect(events.find((event) => event.type === "PHASE_CHANGED" && event.phaseBefore === "AWAITING_APPROVAL")).toMatchObject({
      phaseAfter: "IMPLEMENT",
      causationEventId: approvalResolved?.id,
    });
  });
});

async function scenario(loopResults: ValidationResult[]) {
  const root = await createTempRepository();
  await mkdir(join(root, "src"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "src", "feature.ts"), "export const value = 0;\n", "utf8");
  const clock = new SequenceClock();
  const workspace = new FakeWorkspaceInspector();
  const baseline = new MemoryBaselineService();
  const taskStore = new TaskStore(root);
  const eventStore = new EventStore(root);
  const scripts: ScriptedStep[] = [
    { when: { call: 1, phase: "GENERATE_TESTS" }, action: { version: 1, id: "test", type: "create_file", rationale: "Add target test.", path: "tests/feature.test.ts", content: "expect(value).toBe(2);\n" } },
    { when: { call: 2, phase: "GENERATE_TESTS" }, action: { version: 1, id: "red", type: "run_validation", rationale: "Confirm red.", validator: "test" } },
    ...loopResults.map((_, index): ScriptedStep => ({
      when: { call: index + 3, phase: "IMPLEMENT" },
      action: { version: 1, id: `finish-${index + 1}`, type: "finish", rationale: "Validate unchanged attempt.", summary: `Attempt ${index + 1}.` },
    })),
  ];

  const makeOrchestrator = (
    precheck: () => Promise<ReturnType<typeof repositoryProfile>>,
    validations: ValidationResult[][],
    llm: LLMClient = new ScriptedLLMClient(scripts),
  ): TaskOrchestrator => {
    const policy = new PolicyEngine();
    return new TaskOrchestrator({
      taskStore,
      eventStore,
      precheck,
      baseline,
      policy,
      registry: new ToolRegistry(policy, [...createFileTools({ workspaceRoot: root }), validationTool(validations)]),
      feedback: new FeedbackEngine({ now: clock.now, enabledValidators: ["test"] }),
      llm,
      confirmation: { confirmRed: async () => true },
      workspace,
      now: clock.now,
    });
  };
  const orchestrator = makeOrchestrator(
    async () => repositoryProfile(root),
    [[validationResult("failed", "red")], ...loopResults.map((result) => [result])],
  );
  const taskId = `pause-${loopResults.length}`;
  await orchestrator.start({ id: taskId, repositoryRoot: root, requirement: "Implement feature." });
  return { root, taskId, eventStore, orchestrator, makeOrchestrator };
}

async function runUntilPaused(orchestrator: TaskOrchestrator, taskId: string) {
  let state = await orchestrator.step(taskId);
  for (let index = 0; index < 20 && state.phase !== "PAUSED"; index += 1) state = await orchestrator.step(state.id);
  return state;
}

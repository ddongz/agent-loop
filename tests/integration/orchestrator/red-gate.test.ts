import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { EventStore } from "../../../src/state/event-store.js";
import { TaskStore } from "../../../src/state/task-store.js";
import { PolicyEngine } from "../../../src/governance/policy-engine.js";
import { SentinelError } from "../../../src/domain/error.js";
import { ScriptedLLMClient } from "../../../src/llm/scripted-client.js";
import { TaskOrchestrator, type TaskOrchestratorDependencies } from "../../../src/orchestrator/task-orchestrator.js";
import { createFileTools } from "../../../src/tools/file-tools.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { createTempRepository } from "../../helpers/temp-repository.js";
import {
  FakeWorkspaceInspector,
  MemoryBaselineService,
  SequenceClock,
  repositoryProfile,
  validationResult,
  validationTool,
} from "../../helpers/fakes.js";

describe("TaskOrchestrator red gate", () => {
  it("leaves no task storage when read-only repository precheck fails", async () => {
    const root = await fixture();
    const policy = new PolicyEngine();
    const orchestrator = new TaskOrchestrator({
      taskStore: new TaskStore(root),
      eventStore: new EventStore(root),
      precheck: async () => { throw new SentinelError({ code: "DIRTY_WORKTREE", message: "dirty" }); },
      baseline: new MemoryBaselineService(),
      policy,
      registry: new ToolRegistry(policy, createFileTools({ workspaceRoot: root })),
      feedback: { evaluate: () => { throw new Error("unused"); } },
      llm: new ScriptedLLMClient([]),
      confirmation: { confirmRed: async () => false },
      workspace: new FakeWorkspaceInspector(),
    });

    await expect(orchestrator.start({ id: "precheck-fails", repositoryRoot: root, requirement: "Implement feature." }))
      .rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    await expect(access(join(root, ".sentinelloop"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("denies production writes during test generation and refuses an invalid red", async () => {
    const root = await fixture();
    const baseline = new MemoryBaselineService();
    const clock = new SequenceClock();
    const llm = new ScriptedLLMClient([
      { when: { call: 1, phase: "GENERATE_TESTS" }, action: { version: 1, id: "bad-source", type: "create_file", rationale: "Try source first.", path: "src/feature.ts", content: "changed\n" } },
      { when: { call: 2, phase: "GENERATE_TESTS" }, action: { version: 1, id: "new-test", type: "create_file", rationale: "Add the target test.", path: "tests/feature.test.ts", content: "test('feature', () => {});\n" } },
      { when: { call: 3, phase: "GENERATE_TESTS" }, action: { version: 1, id: "red-check", type: "run_validation", rationale: "Confirm the new test fails.", validator: "test" } },
    ]);
    const orchestrator = harness(root, clock, baseline, llm, [[validationResult("failed", "syntax", "SYNTAX_ERROR")]]);

    let state = await orchestrator.start({ id: "red-invalid", repositoryRoot: root, requirement: "Implement feature." });
    state = await orchestrator.step(state.id);
    expect(state.phase).toBe("GENERATE_TESTS");

    state = await orchestrator.step(state.id);
    expect(state.phase).toBe("GENERATE_TESTS");
    expect(await readFile(join(root, "src", "feature.ts"), "utf8")).toBe("original\n");

    await orchestrator.step(state.id);
    state = await orchestrator.step(state.id);
    expect(state.phase).toBe("GENERATE_TESTS");
    expect(baseline.freezeCalls).toBe(0);
  });

  it("freezes the exact confirmed test set only after an eligible assertion red", async () => {
    const root = await fixture();
    const baseline = new MemoryBaselineService();
    const clock = new SequenceClock();
    const llm = new ScriptedLLMClient([
      { when: { call: 1, phase: "GENERATE_TESTS" }, action: { version: 1, id: "new-test", type: "create_file", rationale: "Add the target test.", path: "tests/feature.test.ts", content: "test('feature', () => {});\n" } },
      { when: { call: 2, phase: "GENERATE_TESTS" }, action: { version: 1, id: "red-check", type: "run_validation", rationale: "Confirm the new test fails.", validator: "test" } },
    ]);
    let evidence: unknown = null;
    const orchestrator = harness(root, clock, baseline, llm, [[validationResult("failed", "assertion")]], async (input) => {
      evidence = input;
      return true;
    });

    let state = await orchestrator.start({ id: "red-valid", repositoryRoot: root, requirement: "Implement feature." });
    state = await orchestrator.step(state.id);
    await orchestrator.step(state.id);
    state = await orchestrator.step(state.id);

    expect(state).toMatchObject({ phase: "IMPLEMENT", baselineVersion: 1 });
    expect(state.protectedTests.map(({ path }) => path)).toEqual(["tests/feature.test.ts"]);
    expect(baseline.freezeCalls).toBe(1);
    expect(evidence).toMatchObject({
      taskId: "red-valid",
      requirement: "Implement feature.",
      testPaths: ["tests/feature.test.ts"],
      testDiff: "diff --git a/tests/feature.test.ts b/tests/feature.test.ts\n+new test\n",
      failureSummary: "test:failed TEST_ASSERTION failure assertion [tests/feature.test.ts:1:1 feature]",
      requirementToTests: [{ requirement: "Implement feature.", testPath: "tests/feature.test.ts", testNames: ["feature"] }],
    });
  });

  it("refuses to freeze when the approved red evidence changes during confirmation", async () => {
    const root = await fixture();
    const baseline = new MemoryBaselineService();
    const clock = new SequenceClock();
    const workspace = new FakeWorkspaceInspector();
    const llm = new ScriptedLLMClient([
      { when: { call: 1, phase: "GENERATE_TESTS" }, action: { version: 1, id: "new-test", type: "create_file", rationale: "Add the target test.", path: "tests/feature.test.ts", content: "test('feature', () => {});\n" } },
      { when: { call: 2, phase: "GENERATE_TESTS" }, action: { version: 1, id: "red-check", type: "run_validation", rationale: "Confirm the new test fails.", validator: "test" } },
    ]);
    const orchestrator = harness(root, clock, baseline, llm, [[validationResult("failed", "assertion")]], async () => {
      workspace.diff += "+unapproved change\n";
      return true;
    }, workspace);

    let state = await orchestrator.start({ id: "red-race", repositoryRoot: root, requirement: "Implement feature." });
    state = await orchestrator.step(state.id);
    await orchestrator.step(state.id);
    state = await orchestrator.step(state.id);

    expect(state.phase).toBe("GENERATE_TESTS");
    expect(baseline.freezeCalls).toBe(0);
  });
});

async function fixture(): Promise<string> {
  const root = await createTempRepository();
  await mkdir(join(root, "src"));
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "src", "feature.ts"), "original\n", "utf8");
  return root;
}

function harness(
  root: string,
  clock: SequenceClock,
  baseline: MemoryBaselineService,
  llm: ScriptedLLMClient,
  validations: Parameters<typeof validationTool>[0],
  confirm: boolean | TaskOrchestratorDependencies["confirmation"]["confirmRed"] = false,
  workspace = new FakeWorkspaceInspector(),
): TaskOrchestrator {
  const policy = new PolicyEngine();
  return new TaskOrchestrator({
    taskStore: new TaskStore(root),
    eventStore: new EventStore(root),
    precheck: async () => repositoryProfile(root),
    baseline,
    policy,
    registry: new ToolRegistry(policy, [...createFileTools({ workspaceRoot: root }), validationTool(validations)]),
    feedback: { evaluate: () => { throw new Error("Feedback is outside this test."); } },
    llm,
    confirmation: { confirmRed: typeof confirm === "function" ? confirm : async () => confirm },
    workspace,
    now: clock.now,
  });
}

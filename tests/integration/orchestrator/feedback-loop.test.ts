import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FeedbackEngine } from "../../../src/feedback/feedback-engine.js";
import { PolicyEngine } from "../../../src/governance/policy-engine.js";
import { ScriptedLLMClient } from "../../../src/llm/scripted-client.js";
import { TaskOrchestrator, hashDiff } from "../../../src/orchestrator/task-orchestrator.js";
import { EventStore } from "../../../src/state/event-store.js";
import { TaskStore } from "../../../src/state/task-store.js";
import { createFileTools } from "../../../src/tools/file-tools.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import {
  FakeWorkspaceInspector,
  MemoryBaselineService,
  SequenceClock,
  eventPayload,
  repositoryProfile,
  validationResult,
  validationTool,
} from "../../helpers/fakes.js";
import { createTempRepository } from "../../helpers/temp-repository.js";

describe("TaskOrchestrator feedback loop", () => {
  it("repairs only with the observed fingerprint and succeeds through the final gate", async () => {
    const root = await createTempRepository();
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "src", "feature.ts"), "export const value = 0;\n", "utf8");
    const clock = new SequenceClock();
    const workspace = new FakeWorkspaceInspector();
    const baseline = new MemoryBaselineService();
    const policy = new PolicyEngine();
    const llm = new ScriptedLLMClient([
      { when: { call: 1, phase: "GENERATE_TESTS" }, action: { version: 1, id: "test", type: "create_file", rationale: "Add the target test.", path: "tests/feature.test.ts", content: "expect(value).toBe(2);\n" } },
      { when: { call: 2, phase: "GENERATE_TESTS" }, action: { version: 1, id: "red", type: "run_validation", rationale: "Confirm red.", validator: "test" } },
      { when: { call: 3, phase: "IMPLEMENT" }, action: patch("wrong", "0", "1") },
      { when: { call: 4, phase: "IMPLEMENT" }, action: { version: 1, id: "finish-wrong", type: "finish", rationale: "Validate the attempt.", summary: "First attempt." } },
      { when: { call: 5, phase: "IMPLEMENT", feedbackFingerprint: "fp-expected-2" }, action: patch("repair", "1", "2") },
      { when: { call: 6, phase: "IMPLEMENT" }, action: { version: 1, id: "finish-fixed", type: "finish", rationale: "Validate the repair.", summary: "Repair complete." } },
    ]);
    const taskStore = new TaskStore(root);
    const eventStore = new EventStore(root);
    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore,
      precheck: async () => repositoryProfile(root),
      baseline,
      policy,
      registry: new ToolRegistry(policy, [
        ...createFileTools({ workspaceRoot: root }),
        validationTool([
          [validationResult("failed", "red")],
          [validationResult("failed", "fp-expected-2")],
          [validationResult("passed", null)],
        ]),
      ]),
      feedback: new FeedbackEngine({ now: clock.now, enabledValidators: ["test"] }),
      llm,
      confirmation: { confirmRed: async () => true },
      workspace,
      now: clock.now,
    });

    let state = await orchestrator.start({ id: "feedback-success", repositoryRoot: root, requirement: "Return value 2." });
    for (let index = 0; index < 10 && state.phase !== "SUCCEEDED"; index += 1) state = await orchestrator.step(state.id);

    expect(state.phase).toBe("SUCCEEDED");
    expect(state.finalValidation).toMatchObject({
      baselineVerified: true,
      workspacePolicyVerified: true,
      codeVersion: hashDiff(workspace.diff),
      results: [{ validator: "test", status: "passed" }],
    });
    expect(state.lastFeedback?.decision).toBe("REQUEST_SUCCESS_CHECK");
    const feedbackEvents = eventPayload(await eventStore.list(state.id), "FEEDBACK_CREATED");
    expect(feedbackEvents.some((payload) => JSON.stringify(payload).includes("fp-expected-2"))).toBe(true);
  });
});

function patch(id: string, from: string, to: string) {
  return {
    version: 1 as const,
    id,
    type: "apply_patch" as const,
    rationale: "Update the implementation.",
    path: "src/feature.ts",
    patch: `--- a/src/feature.ts\n+++ b/src/feature.ts\n@@ -1 +1 @@\n-export const value = ${from};\n+export const value = ${to};\n`,
  };
}

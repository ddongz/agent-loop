import { describe, expect, it } from "vitest";

import type { Action } from "../../../src/domain/action.js";
import { ScriptedLLMClient } from "../../../src/llm/scripted-client.js";
import type { CompletionRequest } from "../../../src/llm/types.js";

const repairAction: Action = {
  version: 1,
  id: "repair-1",
  type: "apply_patch",
  rationale: "Repair the observed assertion failure.",
  path: "src/user.ts",
  patch: "--- a/src/user.ts\n+++ b/src/user.ts\n@@ -1 +1 @@\n-old\n+new\n"
};

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return {
    schemaVersion: 1,
    taskId: "task-7",
    phase: "FEEDBACK",
    context: {
      systemGovernance: "Use exactly one governed tool.",
      requirement: "Return a user by email.",
      current: {
        iteration: 2,
        budget: { maxIterations: 8, maxDurationMs: 60_000, maxTokens: null, maxCostUsd: null },
        usage: { iterations: 2, elapsedMs: 5_000, inputTokens: 100, outputTokens: 20, costUsd: null }
      },
      repositorySummary: "TypeScript repository",
      feedback: {
        decision: "CONTINUE",
        summary: "One assertion failed.",
        currentStage: "test",
        progress: { kind: "unchanged", repeated: ["fp-1"] },
        issueFingerprints: ["fp-1"],
        remainingIterations: 6,
        createdAt: "2026-08-14T00:00:00.000Z"
      },
      events: [],
      observations: []
    },
    tools: [
      {
        name: "apply_patch",
        description: "Apply one exact-context patch.",
        inputSchema: { type: "object" }
      }
    ],
    ...overrides
  };
}

describe("ScriptedLLMClient", () => {
  it("chooses a repair only when the causal feedback fingerprint is present", async () => {
    const client = new ScriptedLLMClient([
      { when: { phase: "FEEDBACK", feedbackFingerprint: "fp-1" }, action: repairAction }
    ]);
    const withoutFingerprint = request({
      phase: "IMPLEMENT",
      context: { ...request().context, feedback: null }
    });

    await expect(client.complete(withoutFingerprint)).rejects.toMatchObject({ code: "SCRIPT_NO_MATCH" });
    await expect(client.complete(request())).resolves.toMatchObject({ outcome: "action", action: repairAction });
  });

  it("matches semantic observations rather than consuming a response queue", async () => {
    const client = new ScriptedLLMClient([
      {
        when: { phase: "IMPLEMENT", observation: { tool: "read_file", status: "succeeded", outputIncludes: "export function" } },
        action: repairAction
      }
    ]);
    const matching = request({
      phase: "IMPLEMENT",
      context: {
        ...request().context,
        observations: [{ actionId: "read-1", tool: "read_file", status: "succeeded", output: "export function find() {}", truncated: false }]
      }
    });

    await expect(client.complete(matching)).resolves.toMatchObject({ action: repairAction });
    await expect(client.complete(matching)).resolves.toMatchObject({ action: repairAction });
  });

  it("supports an explicit call-number predicate and rejects ambiguous matches", async () => {
    const client = new ScriptedLLMClient([
      { when: { call: 1, phase: "FEEDBACK" }, action: repairAction },
      { when: { feedbackFingerprint: "fp-1" }, action: { ...repairAction, id: "ambiguous" } }
    ]);

    await expect(client.complete(request())).rejects.toMatchObject({
      code: "SCRIPT_NO_MATCH",
      message: expect.stringContaining("ambiguous")
    });
  });

  it("validates scripted actions before returning them", () => {
    expect(() => new ScriptedLLMClient([
      { when: { phase: "FEEDBACK" }, action: { ...repairAction, unexpected: true } as unknown as Action }
    ])).toThrowError(expect.objectContaining({ code: "LLM_PROTOCOL" }));
  });

  it("rejects a malformed runtime request instead of matching it", async () => {
    const client = new ScriptedLLMClient([{ when: { phase: "FEEDBACK" }, action: repairAction }]);
    const malformed = { ...request(), tools: [] } as CompletionRequest;

    await expect(client.complete(malformed)).rejects.toMatchObject({ code: "LLM_PROTOCOL" });
  });
});

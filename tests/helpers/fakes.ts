import { createHash } from "node:crypto";

import type { Action, Observation } from "../../src/domain/action.js";
import type { ProtectedTestRef, TaskEvent } from "../../src/domain/task.js";
import type { ValidationResult } from "../../src/domain/validation.js";
import { TestBaseline } from "../../src/governance/test-baseline.js";
import type { RepositoryProfile } from "../../src/repository/workspace.js";
import { ObservationTimer, type Tool } from "../../src/tools/types.js";

export class SequenceClock {
  #tick = 0;

  constructor(private readonly origin = Date.parse("2026-08-14T00:00:00.000Z")) {}

  now = (): string => new Date(this.origin + this.#tick++ * 1_000).toISOString();
}

export class MemoryBaselineService {
  readonly #baselines = new Map<string, TestBaseline>();
  freezeCalls = 0;

  async freeze(taskId: string, input: { root: string; testPaths: readonly string[]; frozenDiff: string; confirmedAt: string }): Promise<{ protectedTests: readonly ProtectedTestRef[]; baselineVersion: number }> {
    this.freezeCalls += 1;
    const baseline = await TestBaseline.freeze(input);
    this.#baselines.set(taskId, baseline);
    return baseline.taskStateSummary();
  }

  async verify(taskId: string, input: { root: string; testPaths: readonly string[]; baselineVersion: number }): Promise<{ matches: boolean }> {
    const baseline = this.#baselines.get(taskId);
    return baseline === undefined ? { matches: false } : baseline.verify(input);
  }
}

export class FakeWorkspaceInspector {
  diff = "diff --git a/tests/feature.test.ts b/tests/feature.test.ts\n+new test\n";
  testPaths: string[] = ["tests/feature.test.ts"];
  policyVerified = true;

  currentDiff = async (): Promise<string> => this.diff;
  listTestPaths = async (): Promise<string[]> => [...this.testPaths];
  verifyPolicy = async (): Promise<boolean> => this.policyVerified;
  diffHash = (): string => createHash("sha256").update(this.diff).digest("hex");
}

export function repositoryProfile(root: string): RepositoryProfile {
  return {
    root,
    packageManager: "npm",
    validationPlan: [{ validator: "test", executable: "npm", args: ["test"], timeoutMs: 1_000, enabled: true }],
  };
}

export function validationTool(outputs: readonly ValidationResult[][]): Tool {
  let index = 0;
  return {
    type: "run_validation",
    schema: { safeParse: (action: Action) => ({ success: action.type === "run_validation", data: action }) } as Tool["schema"],
    constraints: [],
    async execute(action: Action): Promise<Observation> {
      const timer = new ObservationTimer(action);
      const output = outputs[index++];
      return output === undefined ? timer.fail(new Error("No scripted validation remains.")) : timer.succeed(JSON.stringify(output));
    },
  };
}

export function validationResult(
  status: ValidationResult["status"],
  fingerprint: string | null,
  category: ValidationResult["issues"][number]["category"] = "TEST_ASSERTION",
): ValidationResult {
  return {
    validator: "test",
    status,
    exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
    command: { executable: "npm", args: ["test"] },
    startedAt: "2026-08-14T00:00:00.000Z",
    durationMs: 1,
    issues: fingerprint === null ? [] : [{
      category,
      severity: "error",
      message: `failure ${fingerprint}`,
      file: "tests/feature.test.ts",
      line: 1,
      column: 1,
      rule: null,
      testName: "feature",
      fingerprint,
    }],
    stdoutSummary: "",
    stderrSummary: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

export function eventPayload(events: readonly TaskEvent[], type: TaskEvent["type"]): TaskEvent["payload"][] {
  return events.filter((event) => event.type === type).map((event) => event.payload);
}

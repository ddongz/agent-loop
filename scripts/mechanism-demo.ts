import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ActionSchema, type Action, type Observation } from "../src/domain/action.js";
import { SentinelError } from "../src/domain/error.js";
import type { ProtectedTestRef, TaskState } from "../src/domain/task.js";
import { ValidationResultSchema, type Feedback, type ValidationResult } from "../src/domain/validation.js";
import { FeedbackEngine } from "../src/feedback/feedback-engine.js";
import { parseValidation } from "../src/feedback/parsers.js";
import { PolicyEngine } from "../src/governance/policy-engine.js";
import { TestBaseline } from "../src/governance/test-baseline.js";
import { ScriptedLLMClient, type ScriptedStep } from "../src/llm/scripted-client.js";
import type { CompletionRequest, CompletionResult, LLMClient } from "../src/llm/types.js";
import { TaskOrchestrator } from "../src/orchestrator/task-orchestrator.js";
import { generateReport } from "../src/reporting/report-generator.js";
import { precheckRepository, type RepositoryProfile } from "../src/repository/workspace.js";
import { EventStore } from "../src/state/event-store.js";
import { TaskStore } from "../src/state/task-store.js";
import { createFileTools } from "../src/tools/file-tools.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ObservationTimer, type Tool } from "../src/tools/types.js";
import { createValidationTool } from "../src/tools/validation-tool.js";

const expectedFingerprint = parseValidation(realFailureOutput(1), { validator: "test", exitCode: 1 }).issues[0]?.fingerprint ?? "missing";
const unchangedFingerprint = "fp-unchanged";

export interface GovernanceDemoResult {
  scenario: "Governance pre-dispatch block";
  decision: string;
  auditReason: string;
  observationStatus: Observation["status"] | "missing";
  finalState: TaskState["phase"];
  toolExecutions: number;
  passed: boolean;
}

export interface FeedbackDemoResult {
  scenario: "Feedback fingerprint causality";
  refusalCode: string;
  expectedFingerprint: string;
  repairContextFingerprints: string[];
  repairAction: string;
  precheckPackageManager: string;
  validationExitCodes: Array<number | null>;
  finalSource: string;
  finalState: TaskState["phase"];
  finalDecision: Feedback["decision"] | "missing";
  passed: boolean;
}

export interface StallDemoResult {
  scenario: "Deterministic no-progress stall";
  iterations: Array<{ iteration: number; decision: Feedback["decision"] | "missing"; phase: TaskState["phase"] }>;
  finalState: TaskState["phase"];
  pauseReason: string;
  reportNamesNoProgress: boolean;
  passed: boolean;
}

export type DemoResult = GovernanceDemoResult | FeedbackDemoResult | StallDemoResult;

export async function runGovernanceDemo(): Promise<GovernanceDemoResult> {
  return withDemoRepository(async ({ root }) => {
    const clock = new SequenceClock();
    let toolExecutions = 0;
    const action = patchAction("protected-test", "tests/feature.test.ts", "expect(value).toBe(2);", "expect(value).toBe(1);");
    const steps: ScriptedStep[] = [
      testCreationStep(1),
      redValidationStep(2),
      { when: { call: 3, phase: "IMPLEMENT" }, action },
    ];
    const fixture = makeFixture(root, clock, steps, [[validationResult("failed", "red")]], {
      replacePatchTool: countingPatchTool(() => { toolExecutions += 1; }),
    });

    let state = await fixture.orchestrator.start({ id: "governance-demo", repositoryRoot: root, requirement: "Keep the frozen test intact." });
    state = await runUntil(state, fixture.orchestrator, (current) => current.phase === "AWAITING_APPROVAL");
    const events = await fixture.eventStore.list(state.id);
    const policyEvent = events.find((event) => event.type === "POLICY_DECIDED" && event.actionId === action.id);
    const completedEvent = events.find((event) => event.type === "ACTION_COMPLETED" && event.actionId === action.id);
    const decision = stringAt(policyEvent?.payload, "decision", "kind");
    const auditReason = stringAt(policyEvent?.payload, "decision", "reasonCode");
    const observationStatus = stringAt(completedEvent?.payload, "observation", "status") as Observation["status"] | "missing";
    const passed = decision === "REQUIRE_APPROVAL"
      && auditReason === "PROTECTED_TEST_MUTATION"
      && observationStatus === "approval_required"
      && state.phase === "AWAITING_APPROVAL"
      && toolExecutions === 0;
    return {
      scenario: "Governance pre-dispatch block",
      decision,
      auditReason,
      observationStatus,
      finalState: state.phase,
      toolExecutions,
      passed,
    };
  });
}

export async function runFeedbackDemo(): Promise<FeedbackDemoResult> {
  return withRealFeedbackRepository(async ({ root }) => {
    const clock = new SequenceClock();
    const validationOverrides = {
      test: {
        executable: process.execPath,
        args: ["--no-warnings", "--experimental-strip-types", "tests/feature.test.ts"],
        timeoutMs: 5_000,
      },
    };
    const repair = patchAction("repair", "src/feature.ts", "export const value: number = 1;", "export const value: number = 2;");
    const steps: ScriptedStep[] = [
      realTestCreationStep(1),
      redValidationStep(2),
      { when: { call: 3, phase: "IMPLEMENT" }, action: patchAction("wrong", "src/feature.ts", "export const value: number = 0;", "export const value: number = 1;") },
      finishStep(4, "finish-wrong"),
      { when: { call: 5, phase: "IMPLEMENT", feedbackFingerprint: expectedFingerprint }, action: repair },
      finishStep(6, "finish-fixed"),
    ];
    const probe = new FingerprintProbeClient(new ScriptedLLMClient(steps), expectedFingerprint, repair);
    const discovered = await precheckRepository(root, { validationOverrides });
    let precheckPackageManager = "missing";
    const validationExitCodes: Array<number | null> = [];
    const policy = new PolicyEngine();
    const eventStore = new EventStore(root);
    const validation = parsedValidationTool(createValidationTool({
      workspaceRoot: root,
      validationPlan: discovered.validationPlan,
    }), (results) => validationExitCodes.push(...results.map(({ exitCode }) => exitCode)));
    const fixture = {
      eventStore,
      orchestrator: new TaskOrchestrator({
        taskStore: new TaskStore(root),
        eventStore,
        precheck: async (candidate) => {
          const profile = await precheckRepository(candidate, { validationOverrides });
          precheckPackageManager = profile.packageManager;
          return profile;
        },
        baseline: new MemoryBaselineService(),
        policy,
        registry: new ToolRegistry(policy, [...createFileTools({ workspaceRoot: root }), validation]),
        feedback: new FeedbackEngine({ now: clock.now, enabledValidators: ["test"] }),
        llm: probe,
        confirmation: { confirmRed: async () => true },
        workspace: new GitWorkspaceInspector(),
        now: clock.now,
        eventId: clock.eventId,
      }),
    };

    let state = await fixture.orchestrator.start({ id: "feedback-demo", repositoryRoot: root, requirement: "Return value 2." });
    state = await runUntil(state, fixture.orchestrator, (current) => current.phase === "SUCCEEDED");
    const finalSource = await readFile(join(root, "src", "feature.ts"), "utf8");
    const passed = probe.refusalCode === "SCRIPT_NO_MATCH"
      && probe.repairContextFingerprints.includes(expectedFingerprint)
      && probe.repairAction === repair.id
      && precheckPackageManager === "npm"
      && JSON.stringify(validationExitCodes) === JSON.stringify([1, 1, 0])
      && finalSource === "export const value: number = 2;\n"
      && state.phase === "SUCCEEDED"
      && state.lastFeedback?.decision === "REQUEST_SUCCESS_CHECK";
    return {
      scenario: "Feedback fingerprint causality",
      refusalCode: probe.refusalCode,
      expectedFingerprint,
      repairContextFingerprints: probe.repairContextFingerprints,
      repairAction: probe.repairAction,
      precheckPackageManager,
      validationExitCodes,
      finalSource,
      finalState: state.phase,
      finalDecision: state.lastFeedback?.decision ?? "missing",
      passed,
    };
  });
}

export async function runStallDemo(): Promise<StallDemoResult> {
  return withDemoRepository(async ({ root }) => {
    const clock = new SequenceClock();
    const steps: ScriptedStep[] = [
      testCreationStep(1),
      redValidationStep(2),
      finishStep(3, "finish-1"),
      finishStep(4, "finish-2"),
      finishStep(5, "finish-3"),
    ];
    const fixture = makeFixture(root, clock, steps, [
      [validationResult("failed", "red")],
      [validationResult("failed", unchangedFingerprint)],
      [validationResult("failed", unchangedFingerprint)],
      [validationResult("failed", unchangedFingerprint)],
    ]);

    let state = await fixture.orchestrator.start({ id: "stall-demo", repositoryRoot: root, requirement: "Stop an unchanged repair loop." });
    const iterations: StallDemoResult["iterations"] = [];
    for (let step = 0; step < 20 && state.phase !== "PAUSED"; step += 1) {
      const priorIteration = state.iteration;
      state = await fixture.orchestrator.step(state.id);
      if (state.iteration > priorIteration) {
        iterations.push({ iteration: state.iteration, decision: state.lastFeedback?.decision ?? "missing", phase: state.phase });
      }
    }
    const events = await fixture.eventStore.list(state.id);
    const pauseReason = stringAt(events.findLast((event) => event.type === "TASK_PAUSED")?.payload, "reason");
    const reportNamesNoProgress = generateReport(state, events).includes("NO_PROGRESS");
    const passed = JSON.stringify(iterations) === JSON.stringify([
      { iteration: 1, decision: "CONTINUE", phase: "FEEDBACK" },
      { iteration: 2, decision: "CONTINUE", phase: "FEEDBACK" },
      { iteration: 3, decision: "PAUSE_NO_PROGRESS", phase: "PAUSED" },
    ]) && state.phase === "PAUSED" && pauseReason === "PAUSE_NO_PROGRESS" && reportNamesNoProgress;
    return {
      scenario: "Deterministic no-progress stall",
      iterations,
      finalState: state.phase,
      pauseReason,
      reportNamesNoProgress,
      passed,
    };
  });
}

export function renderDemoResults(results: readonly DemoResult[]): string {
  return `${results.map((result) => {
    const event = result.scenario === "Governance pre-dispatch block"
      ? `${result.auditReason} -> ${result.decision}; tool executions=${result.toolExecutions}`
      : result.scenario === "Feedback fingerprint causality"
        ? `missing fingerprint -> ${result.refusalCode}; ${result.expectedFingerprint} -> ${result.repairAction}`
        : `${result.pauseReason} at unchanged iteration ${result.iterations.at(-1)?.iteration ?? "missing"}`;
    return [
      `Scenario: ${result.scenario}`,
      `Key event: ${event}`,
      `Final state: ${result.finalState}`,
      result.passed ? "PASS" : "FAIL",
    ].join("\n");
  }).join("\n\n")}\n`;
}

export async function runDemoCli(): Promise<number> {
  const results = await Promise.all([runGovernanceDemo(), runFeedbackDemo(), runStallDemo()]);
  process.stdout.write(renderDemoResults(results));
  return results.every(({ passed }) => passed) ? 0 : 1;
}

class SequenceClock {
  #tick = 0;
  now = (): string => new Date(Date.parse("2026-08-14T00:00:00.000Z") + this.#tick++ * 1_000).toISOString();
  eventId = (): string => `demo-event-${this.#tick++}`;
}

class MemoryBaselineService {
  readonly #baselines = new Map<string, TestBaseline>();

  async freeze(taskId: string, input: { root: string; testPaths: readonly string[]; frozenDiff: string; confirmedAt: string }): Promise<{ protectedTests: readonly ProtectedTestRef[]; baselineVersion: number }> {
    const baseline = await TestBaseline.freeze(input);
    this.#baselines.set(taskId, baseline);
    return baseline.taskStateSummary();
  }

  async verify(taskId: string, input: { root: string; testPaths: readonly string[]; baselineVersion: number }): Promise<{ matches: boolean }> {
    const baseline = this.#baselines.get(taskId);
    return baseline === undefined ? { matches: false } : baseline.verify(input);
  }

  async approveMutation(taskId: string, input: { root: string; testPaths: readonly string[]; frozenDiff: string; approvedAt: string }): Promise<{ protectedTests: readonly ProtectedTestRef[]; baselineVersion: number }> {
    const baseline = this.#baselines.get(taskId);
    if (baseline === undefined) throw new Error(`Missing baseline for ${taskId}.`);
    const approved = await baseline.approveMutation(input);
    this.#baselines.set(taskId, approved);
    return approved.taskStateSummary();
  }
}

class DemoWorkspace {
  readonly diff = "diff --git a/tests/feature.test.ts b/tests/feature.test.ts\n+expect(value).toBe(2);\n";
  currentDiff = async (): Promise<string> => this.diff;
  listTestPaths = async (): Promise<string[]> => ["tests/feature.test.ts"];
  verifyPolicy = async (): Promise<boolean> => true;
}

class GitWorkspaceInspector {
  async currentDiff(root: string): Promise<string> {
    const tracked = await runProcess("git", ["-C", root, "diff", "--no-ext-diff", "--binary", "--", "."]);
    const untracked = (await runProcess("git", ["-C", root, "ls-files", "--others", "--exclude-standard"]))
      .split("\n").map((path) => path.trim()).filter(Boolean).sort((left, right) => left.localeCompare(right, "en"));
    const additions = await Promise.all(untracked.map(async (path) => untrackedDiff(path, await readFile(join(root, ...path.split("/")), "utf8"))));
    return [tracked.trimEnd(), ...additions].filter(Boolean).join("\n");
  }

  async listTestPaths(root: string): Promise<string[]> {
    const paths = (await runProcess("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard"]))
      .split("\n").map((path) => path.trim()).filter((path) => /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path));
    const existing: string[] = [];
    for (const path of paths) {
      try {
        await access(join(root, ...path.split("/")));
        existing.push(path);
      } catch { /* disappeared during inspection */ }
    }
    return [...new Set(existing)].sort((left, right) => left.localeCompare(right, "en"));
  }

  async verifyPolicy(root: string): Promise<boolean> {
    const status = await runProcess("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"]);
    return !status.split("\n").some((line) => /(?:^|[\\/])(?:\.git|\.sentinelloop|\.env(?:\.|$))/i.test(line.slice(3)));
  }
}

class FingerprintProbeClient implements LLMClient {
  refusalCode = "missing";
  repairContextFingerprints: string[] = [];
  repairAction = "missing";
  #probed = false;

  constructor(
    private readonly delegate: LLMClient,
    private readonly fingerprint: string,
    private readonly repair: Action,
  ) {}

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    if (!this.#probed && request.phase === "IMPLEMENT" && request.context.feedback?.issueFingerprints.includes(this.fingerprint)) {
      this.#probed = true;
      this.repairContextFingerprints = [...request.context.feedback.issueFingerprints];
      const guard = new ScriptedLLMClient([{ when: { call: 1, phase: "IMPLEMENT", feedbackFingerprint: this.fingerprint }, action: this.repair }]);
      try {
        await guard.complete({ ...request, context: { ...request.context, feedback: null } }, signal);
      } catch (error) {
        if (error instanceof SentinelError) this.refusalCode = error.code;
        else throw error;
      }
    }
    const completion = await this.delegate.complete(request, signal);
    if (completion.outcome === "action" && completion.action.id === this.repair.id) this.repairAction = completion.action.id;
    return completion;
  }
}

interface FixtureOptions {
  llm?: LLMClient;
  replacePatchTool?: Tool;
}

function makeFixture(
  root: string,
  clock: SequenceClock,
  steps: readonly ScriptedStep[],
  validations: readonly ValidationResult[][],
  options: FixtureOptions = {},
): { orchestrator: TaskOrchestrator; eventStore: EventStore } {
  const policy = new PolicyEngine();
  const fileTools = createFileTools({ workspaceRoot: root }).filter(({ type }) => options.replacePatchTool === undefined || type !== "apply_patch");
  const eventStore = new EventStore(root);
  const orchestrator = new TaskOrchestrator({
    taskStore: new TaskStore(root),
    eventStore,
    precheck: async () => repositoryProfile(root),
    baseline: new MemoryBaselineService(),
    policy,
    registry: new ToolRegistry(policy, [...fileTools, ...(options.replacePatchTool === undefined ? [] : [options.replacePatchTool]), validationTool(validations)]),
    feedback: new FeedbackEngine({ now: clock.now, enabledValidators: ["test"] }),
    llm: options.llm ?? new ScriptedLLMClient(steps),
    confirmation: { confirmRed: async () => true },
    workspace: new DemoWorkspace(),
    now: clock.now,
    eventId: clock.eventId,
  });
  return { orchestrator, eventStore };
}

function validationTool(outputs: readonly ValidationResult[][]): Tool {
  let index = 0;
  return {
    type: "run_validation",
    schema: ActionSchema.refine((action) => action.type === "run_validation", "Expected run_validation."),
    constraints: [],
    async execute(action): Promise<Observation> {
      const output = outputs[index++];
      const timer = new ObservationTimer(action);
      return output === undefined ? timer.fail(new Error("No scripted validation remains.")) : timer.succeed(JSON.stringify(output));
    },
  };
}

function parsedValidationTool(tool: Tool, record: (results: readonly ValidationResult[]) => void): Tool {
  return {
    type: tool.type,
    schema: tool.schema,
    constraints: tool.constraints,
    async execute(action, signal): Promise<Observation> {
      const observation = await tool.execute(action, signal);
      if (observation.status !== "succeeded") return observation;
      try {
        const raw = JSON.parse(observation.output) as unknown;
        if (!Array.isArray(raw)) return observation;
        const results = raw.map((result) => parseValidation(ValidationResultSchema.parse(result)));
        record(results);
        return { ...observation, output: JSON.stringify(results) };
      } catch {
        return observation;
      }
    },
  };
}

function countingPatchTool(count: () => void): Tool {
  return {
    type: "apply_patch",
    schema: ActionSchema.refine((action) => action.type === "apply_patch", "Expected apply_patch."),
    constraints: [],
    async execute(action): Promise<Observation> {
      count();
      return new ObservationTimer(action).succeed("unexpected patch execution");
    },
  };
}

function validationResult(status: ValidationResult["status"], fingerprint: string | null): ValidationResult {
  return {
    validator: "test",
    status,
    exitCode: status === "passed" ? 0 : 1,
    command: { executable: "npm", args: ["test"] },
    startedAt: "2026-08-14T00:00:00.000Z",
    durationMs: 1,
    issues: fingerprint === null ? [] : [{
      category: "TEST_ASSERTION",
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

function testCreationStep(call: number): ScriptedStep {
  return {
    when: { call, phase: "GENERATE_TESTS" },
    action: {
      version: 1,
      id: "create-test",
      type: "create_file",
      rationale: "Add the target test.",
      path: "tests/feature.test.ts",
      content: "expect(value).toBe(2);\n",
    },
  };
}

function realTestCreationStep(call: number): ScriptedStep {
  return {
    when: { call, phase: "GENERATE_TESTS" },
    action: {
      version: 1,
      id: "create-test",
      type: "create_file",
      rationale: "Add the target TypeScript test.",
      path: "tests/feature.test.ts",
      content: [
        'import { value } from "../src/feature.ts";',
        "interface ExpectedValue { readonly value: 2 }",
        "const expected: ExpectedValue = { value: 2 };",
        "if (value !== expected.value) {",
        "  process.stderr.write(`FAIL tests/feature.test.ts > feature > returns two\\nAssertionError: expected ${value} to be 2\\n ❯ tests/feature.test.ts:5:1\\n`);",
        "  process.exitCode = 1;",
        "}",
        "",
      ].join("\n"),
    },
  };
}

function redValidationStep(call: number): ScriptedStep {
  return {
    when: { call, phase: "GENERATE_TESTS" },
    action: { version: 1, id: "confirm-red", type: "run_validation", rationale: "Confirm the test fails for the feature gap.", validator: "test" },
  };
}

function finishStep(call: number, id: string): ScriptedStep {
  return {
    when: { call, phase: "IMPLEMENT" },
    action: { version: 1, id, type: "finish", rationale: "Request deterministic validation.", summary: "Validate this attempt." },
  };
}

function patchAction(id: string, path: string, from: string, to: string): Extract<Action, { type: "apply_patch" }> {
  return {
    version: 1,
    id,
    type: "apply_patch",
    rationale: "Apply the requested change.",
    path,
    patch: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${from}\n+${to}\n`,
  };
}

function repositoryProfile(root: string): RepositoryProfile {
  return {
    root,
    packageManager: "npm",
    validationPlan: [{ validator: "test", executable: "npm", args: ["test"], timeoutMs: 1_000, enabled: true }],
  };
}

async function runUntil(state: TaskState, orchestrator: TaskOrchestrator, done: (state: TaskState) => boolean): Promise<TaskState> {
  for (let step = 0; step < 20 && !done(state); step += 1) state = await orchestrator.step(state.id);
  return state;
}

async function withDemoRepository<T>(work: (repository: { root: string }) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "sentinelloop-demo-"));
  const root = join(parent, "repository");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "src", "feature.ts"), "export const value = 0;\n", "utf8");
    return await work({ root });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function withRealFeedbackRepository<T>(work: (repository: { root: string }) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), "sentinelloop-real-demo-"));
  const root = join(parent, "repository");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "src", "feature.ts"), "export const value: number = 0;\n", "utf8");
    await writeFile(join(root, ".gitignore"), ".sentinelloop/\n", "utf8");
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "sentinelloop-feedback-demo",
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: { test: "node --no-warnings --experimental-strip-types tests/feature.test.ts" },
    }, null, 2)}\n`, "utf8");
    await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
      name: "sentinelloop-feedback-demo",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "sentinelloop-feedback-demo", version: "1.0.0" } },
    }, null, 2)}\n`, "utf8");
    await runProcess("git", ["init", root]);
    await runProcess("git", ["-C", root, "config", "user.email", "demo@example.invalid"]);
    await runProcess("git", ["-C", root, "config", "user.name", "SentinelLoop Demo"]);
    await runProcess("git", ["-C", root, "add", "."]);
    await runProcess("git", ["-C", root, "commit", "-m", "fixture"]);
    return await work({ root });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function realFailureOutput(actual: number): string {
  return `FAIL tests/feature.test.ts > feature > returns two\nAssertionError: expected ${actual} to be 2\n ❯ tests/feature.test.ts:5:1\n`;
}

function untrackedDiff(path: string, content: string): string {
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

async function runProcess(executable: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${executable} exited ${String(code)}: ${stderr.trim()}`));
    });
  });
}

function stringAt(value: unknown, ...path: string[]): string {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return "missing";
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : "missing";
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath !== "" && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await runDemoCli();
}

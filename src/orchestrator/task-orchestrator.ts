import { createHash, randomUUID } from "node:crypto";

import type { Action, Observation } from "../domain/action.js";
import { SentinelError, type JsonValue } from "../domain/error.js";
import type { ProtectedTestRef, TaskEvent, TaskPhase, TaskState } from "../domain/task.js";
import { TaskStateSchema } from "../domain/task.js";
import { ValidationResultSchema, type Feedback, type ValidationResult } from "../domain/validation.js";
import type { FeedbackHistoryEntry, FeedbackUsage } from "../feedback/feedback-engine.js";
import type { PolicyContext, PolicyDecision } from "../governance/policy-engine.js";
import { buildContext } from "../llm/context-builder.js";
import type { CompletionTool, LLMClient } from "../llm/types.js";
import type { RepositoryProfile } from "../repository/workspace.js";
import type { NewTaskEvent } from "../state/event-store.js";
import { transition } from "../state/transition-table.js";
import type { DispatchContext } from "../tools/registry.js";

export interface StartTaskInput {
  id: string;
  repositoryRoot: string;
  requirement: string;
  budget?: Partial<TaskState["budget"]>;
}

export type ApprovalResolution = { approved: true } | { approved: false; reason: string };

interface TaskStateStore {
  create(state: TaskState): Promise<void>;
  load(taskId: string): Promise<TaskState>;
  save(state: TaskState): Promise<void>;
}

interface TaskEventStore {
  append(taskId: string, event: NewTaskEvent): Promise<TaskEvent>;
  list(taskId: string): Promise<TaskEvent[]>;
}

interface BaselineService {
  freeze(taskId: string, input: {
    root: string;
    testPaths: readonly string[];
    frozenDiff: string;
    confirmedAt: string;
  }): Promise<{ protectedTests: readonly ProtectedTestRef[]; baselineVersion: number }>;
  verify(taskId: string, input: {
    root: string;
    testPaths: readonly string[];
    baselineVersion: number;
  }): Promise<{ matches: boolean }>;
  approveMutation(taskId: string, input: {
    root: string;
    testPaths: readonly string[];
    frozenDiff: string;
    approvedAt: string;
  }): Promise<{ protectedTests: readonly ProtectedTestRef[]; baselineVersion: number }>;
}

interface WorkspaceInspector {
  currentDiff(root: string): Promise<string>;
  listTestPaths(root: string): Promise<readonly string[]>;
  verifyPolicy(root: string): Promise<boolean>;
}

export interface RedConfirmationInput {
  taskId: string;
  requirement: string;
  testPaths: readonly string[];
  testDiff: string;
  failureSummary: string;
  requirementToTests: readonly {
    requirement: string;
    testPath: string;
    testNames: readonly string[];
  }[];
  results: readonly ValidationResult[];
}

interface ConfirmationIO {
  confirmRed(input: RedConfirmationInput): Promise<boolean>;
}

interface FeedbackService {
  evaluate(results: readonly ValidationResult[], history: readonly FeedbackHistoryEntry[], diff: string, usage: FeedbackUsage): Feedback;
}

interface ApprovalService {
  request(action: Action, baselineVersion: number): unknown;
  approve(actionId: string): unknown;
  reject(actionId: string, reason: string): unknown;
}

export interface TaskOrchestratorDependencies {
  taskStore: TaskStateStore;
  eventStore: TaskEventStore;
  precheck(root: string): Promise<RepositoryProfile>;
  baseline: BaselineService;
  policy: { evaluate(context: PolicyContext, action: Action): Promise<PolicyDecision> };
  registry: { dispatch(context: DispatchContext, action: unknown): Promise<Observation> };
  feedback: FeedbackService;
  llm: LLMClient;
  confirmation: ConfirmationIO;
  workspace: WorkspaceInspector;
  approvals?: ApprovalService & DispatchContext["approvals"];
  sensitiveValues?: readonly string[];
  now?: () => string;
  eventId?: () => string;
}

const actionBaseProperties = {
  version: { type: "integer", const: 1 },
  id: { type: "string", minLength: 1, maxLength: 64 },
  rationale: { type: "string", minLength: 1, maxLength: 2_000 },
} as const;
const actionToolSchemas: Readonly<Record<Action["type"], Record<string, JsonValue>>> = {
  read_file: actionSchema("read_file", {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    maxBytes: { type: "integer", minimum: 1, maximum: 1_048_576, default: 65_536 },
  }, ["path"]),
  list_files: actionSchema("list_files", {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    maxDepth: { type: "integer", minimum: 0, maximum: 20, default: 5 },
    maxEntries: { type: "integer", minimum: 1, maximum: 1_000, default: 200 },
  }),
  search_files: actionSchema("search_files", {
    query: { type: "string", minLength: 1, maxLength: 1_000 },
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    glob: { type: "string", minLength: 1, maxLength: 500 },
    maxResults: { type: "integer", minimum: 1, maximum: 1_000, default: 200 },
  }, ["query"]),
  create_file: actionSchema("create_file", {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    content: { type: "string", maxLength: 1_048_576 },
  }, ["path", "content"]),
  apply_patch: actionSchema("apply_patch", {
    path: { type: "string", minLength: 1, maxLength: 4_096 },
    patch: { type: "string", maxLength: 1_048_576 },
  }, ["path", "patch"]),
  run_validation: actionSchema("run_validation", {
    validator: { enum: ["test", "typecheck", "lint", "build", "all"] },
  }, ["validator"]),
  finish: actionSchema("finish", {
    summary: { type: "string", minLength: 1, maxLength: 2_000 },
  }, ["summary"]),
  request_clarification: actionSchema("request_clarification", {
    question: { type: "string", minLength: 1, maxLength: 2_000 },
  }, ["question"]),
};
const completionTools: readonly CompletionTool[] = (Object.keys(actionToolSchemas) as Action["type"][]).map((name) => ({
  name,
  description: `Request the governed ${name} operation.`,
  inputSchema: actionToolSchemas[name],
}));

function actionSchema(
  type: Action["type"],
  properties: Record<string, JsonValue>,
  required: readonly string[] = [],
): Record<string, JsonValue> {
  return {
    type: "object",
    additionalProperties: false,
    properties: { ...actionBaseProperties, type: { const: type }, ...properties },
    required: ["version", "id", "rationale", "type", ...required],
  };
}

export class TaskOrchestrator {
  readonly #deps: TaskOrchestratorDependencies;
  readonly #now: () => string;
  readonly #eventId: () => string;

  constructor(dependencies: TaskOrchestratorDependencies) {
    this.#deps = dependencies;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#eventId = dependencies.eventId ?? randomUUID;
  }

  async start(input: StartTaskInput): Promise<TaskState> {
    const requirement = input.requirement.trim();
    if (requirement.length === 0) throw new SentinelError({ code: "INVALID_INPUT", message: "Task requirement cannot be empty." });
    const profile = await this.#deps.precheck(input.repositoryRoot);
    const createdAt = this.#now();
    const state = TaskStateSchema.parse({
      schemaVersion: 1,
      id: input.id,
      repositoryRoot: profile.root,
      requirement,
      phase: "PRECHECK",
      resumePhase: null,
      iteration: 0,
      budget: {
        maxIterations: input.budget?.maxIterations ?? 8,
        maxDurationMs: input.budget?.maxDurationMs ?? 1_800_000,
        maxTokens: input.budget?.maxTokens ?? null,
        maxCostUsd: input.budget?.maxCostUsd ?? null,
      },
      usage: { iterations: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
      validationPlan: profile.validationPlan,
      protectedTests: [],
      baselineVersion: 0,
      pendingApproval: null,
      lastFeedback: null,
      lastError: null,
      lastCodeChangeAt: null,
      finalValidationAt: null,
      finalValidation: null,
      createdAt,
      updatedAt: createdAt,
    });
    await this.#deps.taskStore.create(state);
    await this.#event(state, "TASK_CREATED", null, "PRECHECK", null, null, null, {});
    return this.#move(state, "ANALYZE_REQUIREMENT");
  }

  async step(taskId: string): Promise<TaskState> {
    const state = await this.#deps.taskStore.load(taskId);
    try {
      if (state.phase === "ANALYZE_REQUIREMENT") return await this.#move(state, "GENERATE_TESTS");
      if (state.phase === "GENERATE_TESTS") return await this.#generateTests(state);
      if (state.phase === "IMPLEMENT") return await this.#implement(state);
      if (state.phase === "VALIDATE") return await this.#validate(state);
      if (state.phase === "FEEDBACK") return await this.#move(state, "IMPLEMENT");
      return state;
    } catch (error) {
      if (!isInterruption(error)) throw error;
      const latest = await this.#deps.taskStore.load(taskId);
      if (!["ANALYZE_REQUIREMENT", "GENERATE_TESTS", "CONFIRM_RED", "IMPLEMENT", "VALIDATE", "FEEDBACK"].includes(latest.phase)) throw error;
      const interrupted = await this.#event(latest, "USER_INTERRUPTED", latest.phase, latest.phase, null, null, null, { reason: "USER_INTERRUPTED" });
      return this.#pause(latest, "USER_INTERRUPTED", interrupted.id);
    }
  }

  async resume(taskId: string, approval?: ApprovalResolution): Promise<TaskState> {
    const loaded = await this.#deps.taskStore.load(taskId);
    if (loaded.phase === "PAUSED") return this.#resumePaused(loaded);
    if (loaded.phase === "AWAITING_APPROVAL") return this.#resumeApproval(loaded, approval);
    return loaded;
  }

  async #resumePaused(paused: TaskState): Promise<TaskState> {
    const resumePhase = paused.resumePhase;
    if (resumePhase === null) throw new SentinelError({ code: "STATE_CORRUPT", message: "Paused task has no resume phase." });
    const pauseEvent = (await this.#deps.eventStore.list(paused.id)).findLast((event) => event.type === "TASK_PAUSED");
    if (pauseEvent === undefined) throw new SentinelError({ code: "STATE_CORRUPT", message: "Paused task has no persisted pause event." });
    let state = await this.#move(paused, "PRECHECK", pauseEvent.id);
    const profile = await this.#deps.precheck(state.repositoryRoot);
    const testPaths = await this.#deps.workspace.listTestPaths(profile.root);
    const baselineVerified = state.baselineVersion === 0 || (await this.#deps.baseline.verify(state.id, {
      root: profile.root,
      testPaths,
      baselineVersion: state.baselineVersion,
    })).matches;
    const policyVerified = await this.#deps.workspace.verifyPolicy(profile.root);
    if (!baselineVerified || !policyVerified) {
      const failed = await this.#move(state, "FAILED");
      await this.#event(failed, "TASK_FAILED", "PRECHECK", "FAILED", null, null, null, { reason: "RECOVERY_PRECHECK_FAILED" });
      return failed;
    }
    state = TaskStateSchema.parse({
      ...state,
      repositoryRoot: profile.root,
      validationPlan: profile.validationPlan,
      updatedAt: this.#now(),
    });
    await this.#deps.taskStore.save(state);
    const resumed = await this.#move(state, resumePhase, pauseEvent.id);
    await this.#event(resumed, "TASK_RESUMED", "PRECHECK", resumePhase, null, null, pauseEvent.id, {
      iteration: resumed.iteration,
      usage: asJson(resumed.usage),
    });
    return resumed;
  }

  async #resumeApproval(state: TaskState, approval: ApprovalResolution | undefined): Promise<TaskState> {
    const pending = state.pendingApproval;
    if (pending === null) throw new SentinelError({ code: "STATE_CORRUPT", message: "Approval state has no pending action." });
    if (approval === undefined) return state;
    const approvalRequest = (await this.#deps.eventStore.list(state.id)).findLast((event) =>
      event.type === "APPROVAL_REQUESTED" && event.actionId === pending.action.id);
    if (approvalRequest === undefined) throw new SentinelError({ code: "STATE_CORRUPT", message: "Approval state has no persisted request event." });
    const approvals = this.#deps.approvals;
    if (approvals === undefined) throw new SentinelError({ code: "INVALID_CONFIG", message: "Approval recovery requires an approval service." });
    if (!approval.approved) {
      resolvePersistedApproval(approvals, pending.action, pending.baselineVersion, { approved: false, reason: approval.reason });
      const resolved = await this.#event(state, "APPROVAL_RESOLVED", "AWAITING_APPROVAL", "PAUSED", pending.action.id, null, approvalRequest.id, { approved: false, reason: approval.reason });
      return this.#pause(state, "APPROVAL_REJECTED", resolved.id);
    }
    resolvePersistedApproval(approvals, pending.action, pending.baselineVersion, { approved: true });
    const resolved = await this.#event(state, "APPROVAL_RESOLVED", "AWAITING_APPROVAL", pending.resumePhase, pending.action.id, null, approvalRequest.id, { approved: true });
    let resumed = await this.#move(state, pending.resumePhase, resolved.id);
    const decision = await this.#deps.policy.evaluate(this.#policyContext(resumed), pending.action);
    const originalRequest = (await this.#deps.eventStore.list(state.id)).findLast((event) =>
      event.type === "ACTION_REQUESTED" && event.actionId === pending.action.id);
    if (originalRequest === undefined) throw new SentinelError({ code: "STATE_CORRUPT", message: "Approval state has no persisted action request." });
    const decided = await this.#event(resumed, "POLICY_DECIDED", resumed.phase, resumed.phase, pending.action.id, null, originalRequest.id, { decision: asJson(decision) });
    const observation = await this.#deps.registry.dispatch(this.#dispatchContext(resumed), pending.action);
    const completed = await this.#event(resumed, "ACTION_COMPLETED", resumed.phase, resumed.phase, pending.action.id, observation.actionId, decided.id, { observation: asJson(observation) });
    if (observation.status !== "succeeded") return this.#pause(resumed, "APPROVED_ACTION_FAILED", completed.id);
    if (pending.action.type === "create_file" || pending.action.type === "apply_patch") {
      const testPaths = await this.#deps.workspace.listTestPaths(resumed.repositoryRoot);
      const diff = await this.#deps.workspace.currentDiff(resumed.repositoryRoot);
      const approvedAt = this.#now();
      const baseline = await this.#deps.baseline.approveMutation(resumed.id, {
        root: resumed.repositoryRoot,
        testPaths,
        frozenDiff: diff,
        approvedAt,
      });
      resumed = TaskStateSchema.parse({
        ...resumed,
        protectedTests: baseline.protectedTests,
        baselineVersion: baseline.baselineVersion,
        lastCodeChangeAt: approvedAt,
        updatedAt: this.#now(),
      });
      await this.#deps.taskStore.save(resumed);
      await this.#event(resumed, "BASELINE_FROZEN", resumed.phase, resumed.phase, null, null, completed.id, {
        approvedMutation: true,
        baselineVersion: baseline.baselineVersion,
        testPaths: [...testPaths],
      });
    }
    return resumed;
  }

  async #generateTests(initial: TaskState): Promise<TaskState> {
    const events = await this.#deps.eventStore.list(initial.id);
    const completion = await this.#deps.llm.complete(buildContext(initial, events, initial.lastFeedback, {
      systemGovernance: "Use one governed tool action and obey the active TDD phase.",
      repositorySummary: "TypeScript package repository.",
      tools: completionTools,
      sensitiveValues: this.#deps.sensitiveValues,
    }));
    let state = await this.#recordUsage(initial, completion.usage);
    if (completion.outcome === "no_action") return this.#move(state, "PAUSED");
    const action = completion.action;
    const requested = await this.#event(state, "ACTION_REQUESTED", state.phase, state.phase, action.id, null, null, { action: asJson(action) });
    const context = this.#policyContext(state);
    const decision = await this.#deps.policy.evaluate(context, action);
    const decided = await this.#event(state, "POLICY_DECIDED", state.phase, state.phase, action.id, null, requested.id, { decision: asJson(decision) });

    if (action.type === "run_validation") state = await this.#move(state, "CONFIRM_RED", decided.id);
    const observation = await this.#deps.registry.dispatch(this.#dispatchContext(state), action);
    const completed = await this.#event(state, "ACTION_COMPLETED", state.phase, state.phase, action.id, observation.actionId, decided.id, { observation: asJson(observation) });
    await this.#deps.taskStore.save(state);

    if (action.type !== "run_validation") return state;
    const results = parseValidationResults(observation);
    const testPaths = await this.#deps.workspace.listTestPaths(state.repositoryRoot);
    const diff = await this.#deps.workspace.currentDiff(state.repositoryRoot);
    if (!isEligibleRed(results, testPaths, diff)) return this.#move(state, "GENERATE_TESTS", completed.id);
    const confirmed = await this.#deps.confirmation.confirmRed({
      taskId: state.id,
      requirement: state.requirement,
      testPaths,
      testDiff: diff,
      failureSummary: redFailureSummary(results),
      requirementToTests: requirementTestMapping(state.requirement, testPaths, results),
      results,
    });
    if (!confirmed) return this.#move(state, "GENERATE_TESTS", completed.id);
    const confirmedTestPaths = await this.#deps.workspace.listTestPaths(state.repositoryRoot);
    const confirmedDiff = await this.#deps.workspace.currentDiff(state.repositoryRoot);
    if (!samePaths(testPaths, confirmedTestPaths) || hashDiff(diff) !== hashDiff(confirmedDiff)) {
      return this.#move(state, "GENERATE_TESTS", completed.id);
    }

    state = await this.#move(state, "FREEZE_TESTS", completed.id);
    const confirmedAt = this.#now();
    const frozen = await this.#deps.baseline.freeze(state.id, {
      root: state.repositoryRoot,
      testPaths,
      frozenDiff: diff,
      confirmedAt,
    });
    state = TaskStateSchema.parse({
      ...state,
      protectedTests: frozen.protectedTests,
      baselineVersion: frozen.baselineVersion,
      updatedAt: this.#now(),
    });
    await this.#deps.taskStore.save(state);
    const baselineEvent = await this.#event(state, "BASELINE_FROZEN", "FREEZE_TESTS", "FREEZE_TESTS", null, null, completed.id, {
      baselineVersion: frozen.baselineVersion,
      testPaths: [...testPaths],
    });
    return this.#move(state, "IMPLEMENT", baselineEvent.id);
  }

  async #implement(initial: TaskState): Promise<TaskState> {
    const events = await this.#deps.eventStore.list(initial.id);
    const completion = await this.#deps.llm.complete(buildContext(initial, events, initial.lastFeedback, {
      systemGovernance: "Use one governed tool action and finish only to request deterministic validation.",
      repositorySummary: "TypeScript package repository.",
      tools: completionTools,
      sensitiveValues: this.#deps.sensitiveValues,
    }));
    let state = await this.#recordUsage(initial, completion.usage);
    if (completion.outcome === "no_action") return this.#pause(state, "NO_ACTION", null);
    const action = completion.action;
    const requested = await this.#event(state, "ACTION_REQUESTED", state.phase, state.phase, action.id, null, null, { action: asJson(action) });
    const decision = await this.#deps.policy.evaluate(this.#policyContext(state), action);
    const decided = await this.#event(state, "POLICY_DECIDED", state.phase, state.phase, action.id, null, requested.id, { decision: asJson(decision) });

    if (action.type === "finish") {
      const observation = controlObservation(action, decision.kind === "ALLOW", this.#now());
      const completed = await this.#event(state, "ACTION_COMPLETED", state.phase, state.phase, action.id, action.id, decided.id, { observation: asJson(observation) });
      return decision.kind === "ALLOW" ? this.#move(state, "VALIDATE", completed.id) : state;
    }

    const observation = await this.#deps.registry.dispatch(this.#dispatchContext(state), action);
    const completed = await this.#event(state, "ACTION_COMPLETED", state.phase, state.phase, action.id, observation.actionId, decided.id, { observation: asJson(observation) });
    if (observation.status === "approval_required") return this.#awaitApproval(state, action, completed.id);
    if (observation.status === "succeeded" && (action.type === "create_file" || action.type === "apply_patch")) {
      state = TaskStateSchema.parse({ ...state, lastCodeChangeAt: this.#now(), updatedAt: this.#now() });
      await this.#deps.taskStore.save(state);
    }
    if (action.type === "request_clarification") return this.#pause(state, "CLARIFICATION_REQUIRED", completed.id);
    return state;
  }

  async #validate(initial: TaskState): Promise<TaskState> {
    const priorEvents = await this.#deps.eventStore.list(initial.id);
    const action: Action = {
      version: 1,
      id: `validation-${initial.iteration + 1}`,
      type: "run_validation",
      rationale: "Run the exact enabled validation plan.",
      validator: "all",
    };
    const requested = await this.#event(initial, "ACTION_REQUESTED", "VALIDATE", "VALIDATE", action.id, null, null, { action: asJson(action) });
    const decision = await this.#deps.policy.evaluate(this.#policyContext(initial), action);
    const decided = await this.#event(initial, "POLICY_DECIDED", "VALIDATE", "VALIDATE", action.id, null, requested.id, { decision: asJson(decision) });
    const validationStartDiff = await this.#deps.workspace.currentDiff(initial.repositoryRoot);
    const observation = await this.#deps.registry.dispatch(this.#dispatchContext(initial), action);
    const completed = await this.#event(initial, "ACTION_COMPLETED", "VALIDATE", "VALIDATE", action.id, observation.actionId, decided.id, { observation: asJson(observation) });
    const results = parseValidationResults(observation);
    const diff = await this.#deps.workspace.currentDiff(initial.repositoryRoot);
    const iteration = initial.iteration + 1;
    const usage = { ...initial.usage, iterations: iteration };
    const feedback = this.#deps.feedback.evaluate(results, validationHistory(priorEvents), diff, usage);
    let state = TaskStateSchema.parse({
      ...initial,
      iteration,
      usage,
      lastFeedback: feedback,
      updatedAt: this.#now(),
    });
    await this.#deps.taskStore.save(state);
    const validationEvent = await this.#event(state, "VALIDATION_COMPLETED", "VALIDATE", "VALIDATE", null, null, completed.id, {
      results: asJson(results),
      diff,
    });
    const feedbackEvent = await this.#event(state, "FEEDBACK_CREATED", "VALIDATE", "VALIDATE", null, null, validationEvent.id, { feedback: asJson(feedback) });

    if (feedback.decision === "REQUEST_SUCCESS_CHECK") return this.#success(state, results, validationStartDiff, diff, feedbackEvent.id);
    if (feedback.decision === "CONTINUE") return this.#move(state, "FEEDBACK", feedbackEvent.id);
    if (feedback.decision === "PAUSE_NO_PROGRESS" || feedback.decision === "PAUSE_BUDGET") {
      state = await this.#move(state, "FEEDBACK", feedbackEvent.id);
      return this.#pause(state, feedback.decision, feedbackEvent.id);
    }
    const failed = await this.#move(state, "FAILED", feedbackEvent.id);
    await this.#event(failed, "TASK_FAILED", "VALIDATE", "FAILED", null, null, feedbackEvent.id, { reason: feedback.decision });
    return failed;
  }

  async #success(
    state: TaskState,
    results: readonly ValidationResult[],
    validationStartDiff: string,
    validationEndDiff: string,
    causationEventId: string,
  ): Promise<TaskState> {
    if (hashDiff(validationStartDiff) !== hashDiff(validationEndDiff)) return this.#move(state, "FEEDBACK", causationEventId);
    const testPaths = await this.#deps.workspace.listTestPaths(state.repositoryRoot);
    const baseline = await this.#deps.baseline.verify(state.id, {
      root: state.repositoryRoot,
      testPaths,
      baselineVersion: state.baselineVersion,
    });
    const workspacePolicyVerified = await this.#deps.workspace.verifyPolicy(state.repositoryRoot);
    const transitionDiff = await this.#deps.workspace.currentDiff(state.repositoryRoot);
    if (hashDiff(validationEndDiff) !== hashDiff(transitionDiff)) return this.#move(state, "FEEDBACK", causationEventId);
    if (!baseline.matches || !workspacePolicyVerified || state.pendingApproval !== null) {
      const feedbackState = await this.#move(state, "FEEDBACK", causationEventId);
      return this.#pause(feedbackState, "SUCCESS_GATE_REJECTED", causationEventId);
    }
    const completedAt = this.#now();
    const ready = TaskStateSchema.parse({
      ...state,
      finalValidationAt: completedAt,
      finalValidation: {
        results,
        baselineVerified: true,
        workspacePolicyVerified: true,
        codeVersion: hashDiff(transitionDiff),
        completedAt,
      },
      updatedAt: completedAt,
    });
    await this.#deps.taskStore.save(ready);
    const succeeded = await this.#move(ready, "SUCCEEDED", causationEventId);
    await this.#event(succeeded, "TASK_SUCCEEDED", "VALIDATE", "SUCCEEDED", null, null, causationEventId, {
      codeVersion: succeeded.finalValidation?.codeVersion ?? "",
    });
    return succeeded;
  }

  async #awaitApproval(state: TaskState, action: Action, causationEventId: string): Promise<TaskState> {
    this.#deps.approvals?.request(action, state.baselineVersion);
    const requestedAt = this.#now();
    const pending = TaskStateSchema.parse({
      ...state,
      pendingApproval: {
        action,
        decisionReason: "PROTECTED_TEST_MUTATION",
        requestedAt,
        resumePhase: state.phase,
        baselineVersion: state.baselineVersion,
      },
      updatedAt: requestedAt,
    });
    await this.#deps.taskStore.save(pending);
    const moved = await this.#move(pending, "AWAITING_APPROVAL", causationEventId);
    await this.#event(moved, "APPROVAL_REQUESTED", state.phase, "AWAITING_APPROVAL", action.id, null, causationEventId, { action: asJson(action) });
    return moved;
  }

  async #pause(state: TaskState, reason: string, causationEventId: string | null): Promise<TaskState> {
    const before = state.phase;
    const paused = await this.#move(state, "PAUSED", causationEventId);
    await this.#event(paused, "TASK_PAUSED", before, "PAUSED", null, null, causationEventId, { reason });
    return paused;
  }

  async #recordUsage(state: TaskState, usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null): Promise<TaskState> {
    const updatedAt = this.#now();
    const next = TaskStateSchema.parse({
      ...state,
      usage: {
        ...state.usage,
        elapsedMs: Math.max(state.usage.elapsedMs, Date.parse(updatedAt) - Date.parse(state.createdAt)),
        inputTokens: state.usage.inputTokens + (usage?.inputTokens ?? 0),
        outputTokens: state.usage.outputTokens + (usage?.outputTokens ?? 0),
        costUsd: addCost(state.usage.costUsd, usage?.costUsd ?? null),
      },
      updatedAt,
    });
    await this.#deps.taskStore.save(next);
    return next;
  }

  async #move(state: TaskState, phase: TaskPhase, causationEventId: string | null = null): Promise<TaskState> {
    const next = transition(state, phase, this.#now());
    await this.#deps.taskStore.save(next);
    await this.#event(next, "PHASE_CHANGED", state.phase, phase, null, null, causationEventId, {});
    return next;
  }

  #policyContext(state: TaskState): PolicyContext {
    return {
      workspaceRoot: state.repositoryRoot,
      phase: state.phase,
      protectedTests: state.protectedTests.map(({ path }) => path),
      baselineVersion: state.baselineVersion,
      approvals: this.#deps.approvals,
    };
  }

  #dispatchContext(state: TaskState): DispatchContext {
    return this.#policyContext(state);
  }

  async #event(
    state: TaskState,
    type: TaskEvent["type"],
    phaseBefore: TaskPhase | null,
    phaseAfter: TaskPhase | null,
    actionId: string | null,
    observationActionId: string | null,
    causationEventId: string | null,
    payload: TaskEvent["payload"],
  ): Promise<TaskEvent> {
    return this.#deps.eventStore.append(state.id, {
      schemaVersion: 1,
      id: this.#eventId(),
      taskId: state.id,
      type,
      timestamp: this.#now(),
      phaseBefore,
      phaseAfter,
      actionId,
      observationActionId,
      causationEventId,
      payload,
    });
  }
}

function redFailureSummary(results: readonly ValidationResult[]): string {
  return results.flatMap((result) => result.issues.map((issue) => {
    const location = `${issue.file ?? "unknown"}:${issue.line ?? 0}:${issue.column ?? 0}`;
    return `${result.validator}:${result.status} ${issue.category} ${issue.message} [${location} ${issue.testName ?? "unknown"}]`;
  })).join("\n");
}

function requirementTestMapping(
  requirement: string,
  testPaths: readonly string[],
  results: readonly ValidationResult[],
): RedConfirmationInput["requirementToTests"] {
  return [...testPaths].sort((left, right) => left.localeCompare(right, "en")).map((testPath) => ({
    requirement,
    testPath,
    testNames: [...new Set(results.flatMap(({ issues }) => issues
      .filter((issue) => issue.file !== null && normalizePath(issue.file) === normalizePath(testPath) && issue.testName !== null)
      .map((issue) => issue.testName as string)))].sort((left, right) => left.localeCompare(right, "en")),
  }));
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].map(normalizePath).sort((a, b) => a.localeCompare(b, "en"));
  const normalizedRight = [...right].map(normalizePath).sort((a, b) => a.localeCompare(b, "en"));
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((path, index) => path === normalizedRight[index]);
}

function parseValidationResults(observation: Observation): ValidationResult[] {
  if (observation.status !== "succeeded") return [];
  try {
    const parsed = JSON.parse(observation.output) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((result) => ValidationResultSchema.parse(result));
  } catch {
    return [];
  }
}

function isEligibleRed(results: readonly ValidationResult[], testPaths: readonly string[], diff: string): boolean {
  if (testPaths.length === 0 || diff.trim().length === 0 || results.length !== 1) return false;
  const result = results[0];
  if (result?.validator !== "test" || result.status !== "failed" || result.exitCode === null) return false;
  const testSet = new Set(testPaths.map(normalizePath));
  return result.issues.length > 0 && result.issues.every((issue) =>
    (issue.category === "TEST_ASSERTION" || issue.category === "TEST_RUNTIME")
    && issue.testName !== null
    && issue.file !== null
    && testSet.has(normalizePath(issue.file))
  );
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function addCost(current: number | null, added: number | null): number | null {
  if (current === null && added === null) return null;
  return (current ?? 0) + (added ?? 0);
}

function validationHistory(events: readonly TaskEvent[]): FeedbackHistoryEntry[] {
  return events.flatMap((event) => {
    if (event.type !== "VALIDATION_COMPLETED") return [];
    const payload = event.payload;
    if (!Array.isArray(payload.results) || typeof payload.diff !== "string") return [];
    try {
      return [{ results: payload.results.map((result) => ValidationResultSchema.parse(result)), diff: payload.diff }];
    } catch {
      throw new SentinelError({ code: "STATE_CORRUPT", message: "Persisted validation history is invalid.", detail: { eventId: event.id } });
    }
  });
}

function controlObservation(action: Action, allowed: boolean, startedAt: string): Observation {
  return {
    actionId: action.id,
    tool: action.type,
    status: allowed ? "succeeded" : "denied",
    startedAt,
    durationMs: 0,
    output: allowed ? "validation requested" : "policy denied finish",
    truncated: false,
    error: allowed ? null : new SentinelError({ code: "POLICY_DENIED", message: "Policy denied finish." }).toJSON((value) => value),
  };
}

function resolvePersistedApproval(
  approvals: ApprovalService,
  action: Action,
  baselineVersion: number,
  resolution: ApprovalResolution,
): void {
  const resolve = (): void => {
    if (resolution.approved) approvals.approve(action.id);
    else approvals.reject(action.id, resolution.reason);
  };
  try {
    resolve();
  } catch (error) {
    if (!(error instanceof SentinelError) || error.code !== "INVALID_INPUT") throw error;
    approvals.request(action, baselineVersion);
    resolve();
  }
}

function isInterruption(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function hashDiff(diff: string): string {
  return createHash("sha256").update(diff.replaceAll("\r\n", "\n").replaceAll("\r", "\n")).digest("hex");
}

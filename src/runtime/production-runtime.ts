import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { ConfigStore } from "../config/config-store.js";
import type { ConfigProfile } from "../config/schema.js";
import { createRedactor } from "../credentials/redaction.js";
import type { CredentialStore } from "../credentials/types.js";
import { ActionSchema, type Action, type Observation } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import { ValidationResultSchema, type ValidationResult } from "../domain/validation.js";
import { parseValidation } from "../feedback/parsers.js";
import { FeedbackEngine } from "../feedback/feedback-engine.js";
import { ApprovalManager } from "../governance/approval.js";
import { PolicyEngine } from "../governance/policy-engine.js";
import { TestBaseline } from "../governance/test-baseline.js";
import { OpenAICompatibleClient } from "../llm/openai-compatible.js";
import type { FetchTransport } from "../llm/types.js";
import {
  TaskOrchestrator,
  type ApprovalResolution,
  type RedConfirmationInput,
  type StartTaskInput,
} from "../orchestrator/task-orchestrator.js";
import { GitWorkspaceInspector } from "../repository/git-workspace.js";
import { precheckRepository, type RepositoryProfile } from "../repository/workspace.js";
import { EventStore } from "../state/event-store.js";
import { TaskStore } from "../state/task-store.js";
import { createFileTools } from "../tools/file-tools.js";
import { ToolRegistry } from "../tools/registry.js";
import { createValidationTool } from "../tools/validation-tool.js";
import { ObservationTimer, type Redactor, type Tool } from "../tools/types.js";

export interface ProductionRuntimeOptions {
  repositoryRoot: string;
  credentials: CredentialStore;
  confirmRed(input: RedConfirmationInput): Promise<boolean>;
  configPath?: string;
  fetch?: FetchTransport;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export class ProductionRuntime {
  readonly #options: ProductionRuntimeOptions;
  readonly #orchestrators = new Map<string, TaskOrchestrator>();

  constructor(options: ProductionRuntimeOptions) {
    this.#options = options;
  }

  async start(input: StartTaskInput) {
    const repository = await precheckRepository(input.repositoryRoot);
    const { orchestrator, profile } = await this.#compose(repository);
    this.#orchestrators.set(input.id, orchestrator);
    return orchestrator.start({
      ...input,
      budget: input.budget ?? {
        maxIterations: profile.policies.maxIterations,
        maxDurationMs: profile.policies.maxDurationMs,
      },
    });
  }

  async step(taskId: string) {
    return (await this.#forTask(taskId)).step(taskId);
  }

  async resume(taskId: string, approval?: ApprovalResolution) {
    return (await this.#forTask(taskId)).resume(taskId, approval);
  }

  async #forTask(taskId: string): Promise<TaskOrchestrator> {
    const cached = this.#orchestrators.get(taskId);
    if (cached !== undefined) return cached;
    const state = await new TaskStore(this.#options.repositoryRoot).load(taskId);
    const repository: RepositoryProfile = {
      root: state.repositoryRoot,
      packageManager: "npm",
      validationPlan: state.validationPlan,
    };
    const { orchestrator } = await this.#compose(repository);
    this.#orchestrators.set(taskId, orchestrator);
    return orchestrator;
  }

  async #compose(repository: RepositoryProfile): Promise<{ orchestrator: TaskOrchestrator; profile: ConfigProfile }> {
    const configPath = this.#options.configPath ?? defaultConfigPath(
      this.#options.environment,
      this.#options.homeDirectory,
    );
    const config = await new ConfigStore(configPath).load();
    const profile = config.profiles.default;
    if (profile === undefined) {
      throw new SentinelError({
        code: "INVALID_CONFIG",
        message: `Default profile is not configured in ${configPath}.`,
      });
    }
    const apiKey = await this.#options.credentials.get("default");
    if (apiKey === null) {
      throw new SentinelError({
        code: "LLM_AUTH",
        message: "Credential profile default is not configured; run sentinelloop auth set --profile default.",
      });
    }

    const now = monotonicClock();
    const taskStore = new TaskStore(repository.root);
    const eventStore = new EventStore(repository.root);
    const approvals = new ApprovalManager(now);
    const policy = new PolicyEngine();
    const redactor = createRedactor([apiKey]);
    const validation = parsedValidationTool(createValidationTool({
      workspaceRoot: repository.root,
      validationPlan: repository.validationPlan,
      redact: redactor,
    }));
    const enabledValidators = repository.validationPlan.filter(({ enabled }) => enabled).map(({ validator }) => validator);
    const registry = new ToolRegistry(policy, [
      ...createFileTools({ workspaceRoot: repository.root, redact: redactor }),
      validation,
      clarificationTool(redactor),
    ], redactor);

    const orchestrator = new TaskOrchestrator({
      taskStore,
      eventStore,
      precheck: (root) => precheckRepository(root, { allowDirty: true }),
      baseline: new StateBaselineService(taskStore),
      policy,
      registry,
      feedback: new FeedbackEngine({
        now,
        enabledValidators,
        budget: profile.policies,
      }),
      llm: new OpenAICompatibleClient({
        baseURL: profile.baseUrl,
        model: profile.model,
        apiKey,
        approvedHeaderNames: profile.allowedHeaderNames,
        fetch: this.#options.fetch,
      }),
      confirmation: { confirmRed: this.#options.confirmRed },
      workspace: new GitWorkspaceInspector(),
      approvals,
      sensitiveValues: [apiKey],
      now,
    });
    return { orchestrator, profile };
  }
}

export function defaultConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const override = environment.SENTINELLOOP_CONFIG?.trim();
  if (override !== undefined && override.length > 0) return isAbsolute(override) ? override : resolve(override);
  if (process.platform === "win32") {
    return join(environment.APPDATA?.trim() || join(homeDirectory, "AppData", "Roaming"), "SentinelLoop", "config.json");
  }
  return join(environment.XDG_CONFIG_HOME?.trim() || join(homeDirectory, ".config"), "sentinelloop", "config.json");
}

class StateBaselineService {
  constructor(private readonly taskStore: TaskStore) {}

  async freeze(_taskId: string, input: Parameters<typeof TestBaseline.freeze>[0]) {
    return (await TestBaseline.freeze(input)).taskStateSummary();
  }

  async verify(taskId: string, input: { root: string; testPaths: readonly string[]; baselineVersion: number }) {
    const state = await this.taskStore.load(taskId);
    if (state.baselineVersion === 0 || state.protectedTests.length === 0) return { matches: false };
    const confirmedAt = state.protectedTests[0]!.frozenAt;
    const baseline = TestBaseline.restore({
      schemaVersion: 1,
      currentVersion: state.baselineVersion,
      versions: [{
        version: state.baselineVersion,
        protectedTests: state.protectedTests,
        frozenDiff: "",
        confirmedAt,
        approval: null,
      }],
    });
    return baseline.verify(input);
  }

  async approveMutation(taskId: string, input: {
    root: string;
    testPaths: readonly string[];
    frozenDiff: string;
    approvedAt: string;
  }) {
    const state = await this.taskStore.load(taskId);
    return (await TestBaseline.freeze({
      root: input.root,
      testPaths: input.testPaths,
      frozenDiff: input.frozenDiff,
      confirmedAt: input.approvedAt,
      version: state.baselineVersion + 1,
    })).taskStateSummary();
  }
}

function parsedValidationTool(tool: Tool): Tool {
  return {
    ...tool,
    async execute(action: Action, signal: AbortSignal): Promise<Observation> {
      const observation = await tool.execute(action, signal);
      if (observation.status !== "succeeded") return observation;
      const raw = JSON.parse(observation.output) as unknown;
      if (!Array.isArray(raw)) throw new SentinelError({ code: "INTERNAL", message: "Validation tool returned a non-array result." });
      const results: ValidationResult[] = raw.map((result) => parseValidation(ValidationResultSchema.parse(result)));
      return { ...observation, output: JSON.stringify(results) };
    },
  };
}

function clarificationTool(redact: Redactor): Tool {
  return {
    type: "request_clarification",
    schema: ActionSchema.refine((action) => action.type === "request_clarification", "Expected request_clarification action."),
    constraints: [],
    async execute(action): Promise<Observation> {
      const timer = new ObservationTimer(action, redact);
      return action.type === "request_clarification"
        ? timer.succeed(action.question)
        : timer.fail(new SentinelError({ code: "INVALID_ACTION", message: "Action type does not match request_clarification." }));
    },
  };
}

function monotonicClock(): () => string {
  let previous = 0;
  return () => {
    const current = Math.max(Date.now(), previous + 1);
    previous = current;
    return new Date(current).toISOString();
  };
}

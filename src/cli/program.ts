import { Command, CommanderError } from "commander";

import type { CredentialStore } from "../credentials/types.js";
import { redactText } from "../credentials/redaction.js";
import { SentinelError } from "../domain/error.js";
import type { TaskEvent, TaskState } from "../domain/task.js";
import type { ApprovalResolution, StartTaskInput } from "../orchestrator/task-orchestrator.js";
import { generateReport } from "../reporting/report-generator.js";
import { ExitCode, exitCodeForError, type ExitCode as ExitCodeValue } from "./exit-codes.js";

export interface CliIO {
  readSecret(prompt: string): Promise<string>;
  writeOut(text: string): void;
  writeError(text: string): void;
}

interface OrchestratorPort {
  start(input: StartTaskInput): Promise<TaskState>;
  step(taskId: string): Promise<TaskState>;
  resume(taskId: string, approval?: ApprovalResolution): Promise<TaskState>;
}

interface TaskReader {
  load(taskId: string): Promise<TaskState>;
}

interface EventReader {
  list(taskId: string): Promise<TaskEvent[]>;
}

export interface CliDependencies {
  io: CliIO;
  credentials: CredentialStore;
  orchestrator: OrchestratorPort;
  taskStore: TaskReader;
  eventStore: EventReader;
  cwd?: () => string;
  taskId?: () => string;
  sensitiveValues?: () => readonly string[] | Promise<readonly string[]>;
}

export interface CliProgram {
  execute(argv: readonly string[]): Promise<ExitCodeValue>;
}

const boundaryPhases = new Set<TaskState["phase"]>(["AWAITING_APPROVAL", "PAUSED", "SUCCEEDED", "FAILED"]);

export function createProgram(dependencies: CliDependencies): CliProgram {
  return {
    async execute(argv: readonly string[]): Promise<ExitCodeValue> {
      let result: ExitCodeValue = ExitCode.SUCCESS;
      const runtimeSecrets: string[] = [];
      const command = new Command()
        .name("sentinelloop")
        .description("Deterministic TDD coding-agent harness")
        .showHelpAfterError(false)
        .exitOverride()
        .configureOutput({
          writeOut: (text) => dependencies.io.writeOut(text.trimEnd()),
          writeErr: (text) => dependencies.io.writeError(redactText(text.trimEnd(), runtimeSecrets)),
        });

      const auth = command.command("auth").description("Manage API keys in the operating-system credential manager");
      auth.command("set")
        .option("--profile <name>", "credential profile", "default")
        .action(async ({ profile }: { profile: string }) => {
          const secret = await dependencies.io.readSecret("API key: ");
          runtimeSecrets.push(secret);
          await dependencies.credentials.set(profile, secret);
          dependencies.io.writeOut(`Credential profile ${profile} configured.`);
        });
      auth.command("status")
        .option("--profile <name>", "credential profile", "default")
        .action(async ({ profile }: { profile: string }) => {
          const metadata = await dependencies.credentials.metadata(profile);
          dependencies.io.writeOut(metadata.configured
            ? `Credential profile ${profile} is configured (updated ${metadata.updatedAt ?? "unknown"}).`
            : `Credential profile ${profile} is not configured.`);
        });
      auth.command("clear")
        .option("--profile <name>", "credential profile", "default")
        .action(async ({ profile }: { profile: string }) => {
          const removed = await dependencies.credentials.delete(profile);
          dependencies.io.writeOut(`Credential profile ${profile} ${removed ? "cleared" : "was already clear"}.`);
        });

      command.command("run")
        .argument("<requirement>")
        .option("--repository <path>", "target repository", dependencies.cwd?.() ?? process.cwd())
        .action(async (requirement: string, { repository }: { repository: string }) => {
          if (requirement.trim().length === 0) {
            throw new SentinelError({ code: "INVALID_INPUT", message: "Task requirement cannot be empty." });
          }
          const task = await dependencies.orchestrator.start({
            id: dependencies.taskId?.() ?? crypto.randomUUID(),
            repositoryRoot: repository,
            requirement: requirement.trim(),
          });
          const finalState = await driveToBoundary(dependencies.orchestrator, task);
          dependencies.io.writeOut(`Task ${finalState.id}: ${finalState.phase}`);
          result = stateExitCode(finalState);
        });

      command.command("resume")
        .argument("<task-id>")
        .option("--approve", "approve the pending action once")
        .option("--reject <reason>", "reject the pending action")
        .action(async (taskId: string, options: { approve?: boolean; reject?: string }) => {
          if (options.approve && options.reject !== undefined) {
            throw new SentinelError({ code: "INVALID_INPUT", message: "Choose either --approve or --reject, not both." });
          }
          const approval: ApprovalResolution | undefined = options.approve
            ? { approved: true }
            : options.reject === undefined ? undefined : { approved: false, reason: options.reject };
          const resumed = await dependencies.orchestrator.resume(taskId, approval);
          const finalState = await driveToBoundary(dependencies.orchestrator, resumed);
          dependencies.io.writeOut(`Task ${finalState.id}: ${finalState.phase}`);
          result = stateExitCode(finalState);
        });

      command.command("status")
        .argument("<task-id>")
        .action(async (taskId: string) => {
          const task = await dependencies.taskStore.load(taskId);
          dependencies.io.writeOut(`Task ${task.id}: ${task.phase}; iteration ${task.iteration}/${task.budget.maxIterations}`);
          result = stateExitCode(task, true);
        });

      command.command("report")
        .argument("<task-id>")
        .action(async (taskId: string) => {
          const [task, events, sensitiveValues] = await Promise.all([
            dependencies.taskStore.load(taskId),
            dependencies.eventStore.list(taskId),
            dependencies.sensitiveValues?.() ?? [],
          ]);
          dependencies.io.writeOut(generateReport(task, events, { sensitiveValues }));
        });

      try {
        await command.parseAsync([...argv], { from: "user" });
        return result;
      } catch (error) {
        if (error instanceof CommanderError) return error.exitCode === 0 ? ExitCode.SUCCESS : ExitCode.USER_ERROR;
        if (isInterruption(error)) return ExitCode.INTERRUPTED;
        const message = error instanceof Error ? error.message : "Unexpected internal failure.";
        dependencies.io.writeError(redactText(message, runtimeSecrets));
        return error instanceof SentinelError ? exitCodeForError(error.code) : ExitCode.INTERNAL_ERROR;
      }
    },
  };
}

async function driveToBoundary(orchestrator: OrchestratorPort, initial: TaskState): Promise<TaskState> {
  let state = initial;
  for (let count = 0; !boundaryPhases.has(state.phase) && count < 128; count += 1) {
    state = await orchestrator.step(state.id);
  }
  if (!boundaryPhases.has(state.phase)) {
    throw new SentinelError({ code: "INTERNAL", message: "Task did not reach a stable CLI boundary." });
  }
  return state;
}

function stateExitCode(state: TaskState, statusOnly = false): ExitCodeValue {
  if (statusOnly) return ExitCode.SUCCESS;
  if (state.phase === "SUCCEEDED") return ExitCode.SUCCESS;
  if (state.phase === "PAUSED" || state.phase === "AWAITING_APPROVAL") return ExitCode.PAUSED;
  if (state.phase === "FAILED" && state.lastError !== null) return exitCodeForError(state.lastError.code);
  return ExitCode.INTERNAL_ERROR;
}

function isInterruption(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

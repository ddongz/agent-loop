import { spawn } from "node:child_process";

import { ActionSchema, type Action, type Observation } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import type { ValidationResult } from "../domain/validation.js";
import type { ValidationCommand, ValidationPlan } from "../repository/validation-discovery.js";
import { identityRedactor, ObservationTimer, type Redactor, type Tool } from "./types.js";

const streamLimit = 65_536;

export interface ValidationToolOptions {
  workspaceRoot: string;
  validationPlan: ValidationPlan;
  redact?: Redactor;
}

export function createValidationTool(options: ValidationToolOptions): Tool {
  const plan = options.validationPlan.map((command) => ({ ...command, args: [...command.args] }));
  const redact = options.redact ?? identityRedactor;
  return {
    type: "run_validation",
    schema: ActionSchema.refine((action) => action.type === "run_validation", "Expected run_validation action."),
    constraints: [],
    async execute(action: Action, signal: AbortSignal): Promise<Observation> {
      const timer = new ObservationTimer(action, redact);
      if (action.type !== "run_validation") {
        return timer.fail(new SentinelError({ code: "INVALID_ACTION", message: "Action type does not match run_validation." }));
      }
      try {
        const commands = selectCommands(plan, action.validator);
        const results: ValidationResult[] = [];
        for (const command of commands) {
          const result = await runValidationCommand(options.workspaceRoot, command, signal);
          results.push(result);
          if (result.status !== "passed") break;
        }
        return timer.succeed(JSON.stringify(results));
      } catch (error) {
        return timer.fail(error);
      }
    },
  };
}

export async function runValidationCommand(
  workspaceRoot: string,
  command: ValidationCommand,
  signal: AbortSignal,
): Promise<ValidationResult> {
  if (!command.enabled) throw invalidInput(`Validator is disabled: ${command.validator}`);
  if (signal.aborted) throw timeoutError("Validation was aborted before it started.");
  const startedAt = new Date();
  const started = performance.now();
  const stdout = new BoundedStream(streamLimit);
  const stderr = new BoundedStream(streamLimit);

  const result = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
    let terminationReason: "timeout" | "abort" | null = null;
    let settled = false;
    const child = spawn(platformExecutable(command.executable), [...command.args], {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer | string) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => stderr.append(chunk));

    const terminate = (reason: "timeout" | "abort"): void => {
      if (terminationReason !== null || settled) return;
      terminationReason = reason;
      void terminateTree(child.pid).catch(() => child.kill("SIGKILL"));
    };
    const timeout = setTimeout(() => terminate("timeout"), command.timeoutMs);
    const abort = (): void => terminate("abort");
    signal.addEventListener("abort", abort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new SentinelError({ code: "VALIDATION_INFRASTRUCTURE", message: "Validation process could not be started.", cause: error }));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminationReason !== null) {
        reject(timeoutError(terminationReason === "timeout" ? "Validation exceeded its time limit." : "Validation was aborted."));
      } else {
        resolve({ exitCode });
      }
    });
  });

  return {
    validator: command.validator,
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    command: { executable: command.executable, args: [...command.args] },
    startedAt: startedAt.toISOString(),
    durationMs: Math.max(0, performance.now() - started),
    issues: [],
    stdoutSummary: stdout.text(),
    stderrSummary: stderr.text(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  };
}

function selectCommands(plan: ValidationPlan, validator: Extract<Action, { type: "run_validation" }>["validator"]): ValidationCommand[] {
  if (validator === "all") {
    const enabled = plan.filter(({ enabled }) => enabled);
    if (enabled.length === 0) throw invalidInput("No validation commands are enabled.");
    return enabled;
  }
  const command = plan.find((candidate) => candidate.validator === validator);
  if (command === undefined) throw invalidInput(`Validator is not present in the discovered plan: ${validator}`);
  if (!command.enabled) throw invalidInput(`Validator is disabled: ${validator}`);
  return [command];
}

class BoundedStream {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #length = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  append(chunk: Buffer | string): void {
    const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.#limit - this.#length;
    if (remaining > 0) {
      const stored = content.subarray(0, remaining);
      this.#chunks.push(stored);
      this.#length += stored.byteLength;
    }
    if (content.byteLength > remaining) this.truncated = true;
  }

  text(): string {
    return new TextDecoder("utf-8").decode(Buffer.concat(this.#chunks, this.#length));
  }
}

async function terminateTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
    const escalation = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* process tree already ended */ }
    }, 250);
    escalation.unref();
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* process already ended */ }
  }
}

function platformExecutable(executable: string): string {
  if (process.platform !== "win32" || /\.[^/\\]+$/.test(executable)) return executable;
  return executable === "npm" || executable === "pnpm" || executable === "yarn" ? `${executable}.cmd` : executable;
}

function timeoutError(message: string): SentinelError {
  return new SentinelError({ code: "TOOL_TIMEOUT", message });
}

function invalidInput(message: string): SentinelError {
  return new SentinelError({ code: "INVALID_INPUT", message });
}

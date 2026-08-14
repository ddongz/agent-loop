import { describe, expect, it, vi } from "vitest";

import { createProgram, type CliDependencies, type CliIO } from "../../../src/cli/program.js";
import { ExitCode } from "../../../src/cli/exit-codes.js";
import { MemoryCredentialStore } from "../../../src/credentials/memory-store.js";
import { SentinelError } from "../../../src/domain/error.js";
import type { TaskEvent, TaskState } from "../../../src/domain/task.js";

function state(phase: TaskState["phase"], id = "task-9"): TaskState {
  return {
    schemaVersion: 1,
    id,
    repositoryRoot: "/repo",
    requirement: "Add a CLI",
    phase,
    resumePhase: phase === "PAUSED" ? "IMPLEMENT" : null,
    iteration: 0,
    budget: { maxIterations: 8, maxDurationMs: 1_800_000, maxTokens: null, maxCostUsd: null },
    usage: { iterations: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    validationPlan: [],
    protectedTests: [],
    baselineVersion: 0,
    pendingApproval: null,
    lastFeedback: null,
    lastError: null,
    lastCodeChangeAt: null,
    finalValidationAt: null,
    finalValidation: null,
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
  };
}

function harness(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIO = {
    readSecret: vi.fn(async () => "opaque-value-4nY7q"),
    writeOut: (text) => stdout.push(text),
    writeError: (text) => stderr.push(text),
  };
  const orchestrator = {
    start: vi.fn(async () => state("SUCCEEDED")),
    step: vi.fn(async () => state("SUCCEEDED")),
    resume: vi.fn(async () => state("SUCCEEDED")),
  };
  const taskStore = { load: vi.fn(async (id: string) => state("PAUSED", id)) };
  const eventStore = { list: vi.fn(async () => [] as TaskEvent[]) };
  const credentials = new MemoryCredentialStore(() => "2026-08-14T08:00:00.000Z");
  const dependencies: CliDependencies = {
    io,
    credentials,
    orchestrator,
    taskStore,
    eventStore,
    cwd: () => "/repo",
    taskId: () => "task-9",
    ...overrides,
  };
  return { program: createProgram(dependencies), dependencies, io, stdout, stderr, orchestrator, taskStore, eventStore, credentials };
}

describe("CLI", () => {
  it("supports hidden auth set/status/clear without emitting any key fragment", async () => {
    const app = harness();
    const secret = "opaque-value-4nY7q";

    expect(await app.program.execute(["auth", "set", "--profile", "team"])).toBe(ExitCode.SUCCESS);
    expect(await app.program.execute(["auth", "status", "--profile", "team"])).toBe(ExitCode.SUCCESS);
    expect(app.io.readSecret).toHaveBeenCalledOnce();
    expect(app.stdout.join("\n")).toContain("configured");
    expect(app.stdout.join("\n") + app.stderr.join("\n")).not.toContain(secret.slice(0, 6));
    expect(await app.program.execute(["auth", "clear", "--profile", "team"])).toBe(ExitCode.SUCCESS);
    expect(await app.credentials.get("team")).toBeNull();
  });

  it("does not accept an API key command option", async () => {
    const app = harness();

    expect(await app.program.execute(["auth", "set", "--api-key", "plaintext-secret"])).toBe(ExitCode.USER_ERROR);
    expect(app.io.readSecret).not.toHaveBeenCalled();
    expect(app.stdout.join("\n") + app.stderr.join("\n")).not.toContain("plaintext-secret");
  });

  it("rejects an empty run requirement before starting a task", async () => {
    const app = harness();

    expect(await app.program.execute(["run", "   "])).toBe(ExitCode.USER_ERROR);
    expect(app.orchestrator.start).not.toHaveBeenCalled();
  });

  it("runs a requirement through the Task 8 start/step interface", async () => {
    const app = harness();
    app.orchestrator.start.mockResolvedValueOnce(state("IMPLEMENT"));
    app.orchestrator.step.mockResolvedValueOnce(state("SUCCEEDED"));

    expect(await app.program.execute(["run", "Add a CLI", "--repository", "/repo"])).toBe(ExitCode.SUCCESS);
    expect(app.orchestrator.start).toHaveBeenCalledWith({ id: "task-9", repositoryRoot: "/repo", requirement: "Add a CLI" });
    expect(app.orchestrator.step).toHaveBeenCalledWith("task-9");
  });

  it("resumes to a pause code and exposes status and redacted reports", async () => {
    const app = harness();
    app.orchestrator.resume.mockResolvedValueOnce(state("PAUSED"));

    expect(await app.program.execute(["resume", "task-9"])).toBe(ExitCode.PAUSED);
    expect(await app.program.execute(["status", "task-9"])).toBe(ExitCode.SUCCESS);
    expect(await app.program.execute(["report", "task-9"])).toBe(ExitCode.SUCCESS);
    expect(app.stdout.join("\n")).toContain("PAUSED");
    expect(app.taskStore.load).toHaveBeenCalledWith("task-9");
    expect(app.eventStore.list).toHaveBeenCalledWith("task-9");
  });

  it.each([
    ["INVALID_CONFIG", ExitCode.USER_ERROR],
    ["NOT_GIT_REPOSITORY", ExitCode.ENVIRONMENT_ERROR],
    ["INTERNAL", ExitCode.INTERNAL_ERROR],
  ] as const)("maps %s to its stable exit code", async (code, expected) => {
    const app = harness({
      taskStore: { load: async () => { throw new SentinelError({ code, message: "safe failure" }); } },
    });

    expect(await app.program.execute(["status", "task-9"])).toBe(expected);
    expect(app.stderr.join("\n")).toContain("safe failure");
  });
});

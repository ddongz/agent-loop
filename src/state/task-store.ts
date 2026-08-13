/// <reference types="node" />

import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { SentinelError } from "../domain/error.js";
import { TaskStateSchema, type TaskState } from "../domain/task.js";

export class TaskStore {
  constructor(private readonly repositoryRoot: string) {}

  async create(state: TaskState): Promise<void> {
    const validated = parseForWrite(state);
    const statePath = this.statePath(validated.id);
    try {
      await access(statePath, constants.F_OK);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.writeAtomically(validated);
        return;
      }
      throw persistenceError("Could not check existing task state.", validated.id, error);
    }

    throw persistenceError("Task state already exists.", validated.id);
  }

  async load(taskId: string): Promise<TaskState> {
    assertSafeTaskId(taskId, "STATE_CORRUPT");
    let contents: string;
    try {
      contents = await readFile(this.statePath(taskId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new SentinelError({
          code: "TASK_NOT_FOUND",
          message: `Task ${taskId} was not found.`,
          detail: { taskId },
          cause: error
        });
      }
      throw persistenceError("Could not read task state.", taskId, error);
    }

    try {
      const state = TaskStateSchema.parse(JSON.parse(contents));
      if (state.id !== taskId) throw new Error("Task ID does not match its directory.");
      return state;
    } catch (error) {
      throw corruptStateError("Task state is not valid.", taskId, error);
    }
  }

  async save(state: TaskState): Promise<void> {
    const validated = parseForWrite(state);
    try {
      await access(this.statePath(validated.id), constants.F_OK);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new SentinelError({
          code: "TASK_NOT_FOUND",
          message: `Task ${validated.id} was not found.`,
          detail: { taskId: validated.id },
          cause: error
        });
      }
      throw persistenceError("Could not check task state before saving.", validated.id, error);
    }
    await this.writeAtomically(validated);
  }

  private async writeAtomically(state: TaskState): Promise<void> {
    const directory = this.taskDirectory(state.id);
    const temporaryPath = join(directory, "state.json.tmp");
    const destinationPath = this.statePath(state.id);
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      await mkdir(directory, { recursive: true });
      handle = await open(temporaryPath, "w");
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw persistenceError("Could not persist task state.", state.id, error);
    }
  }

  private taskDirectory(taskId: string): string {
    return join(this.repositoryRoot, ".sentinelloop", "tasks", taskId);
  }

  private statePath(taskId: string): string {
    return join(this.taskDirectory(taskId), "state.json");
  }
}

function parseForWrite(state: TaskState): TaskState {
  try {
    const validated = TaskStateSchema.parse(state);
    assertSafeTaskId(validated.id, "PERSISTENCE_FAILED");
    return validated;
  } catch (error) {
    throw persistenceError("Refusing to persist invalid task state.", state.id, error);
  }
}

function assertSafeTaskId(taskId: string, code: "PERSISTENCE_FAILED" | "STATE_CORRUPT"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
    throw new SentinelError({ code, message: "Task ID is not a safe path segment.", detail: { taskId } });
  }
}

function corruptStateError(message: string, taskId: string, cause?: unknown): SentinelError {
  return new SentinelError({ code: "STATE_CORRUPT", message, detail: { taskId }, cause });
}

function persistenceError(message: string, taskId: string, cause?: unknown): SentinelError {
  return new SentinelError({ code: "PERSISTENCE_FAILED", message, detail: { taskId }, cause });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/// <reference types="node" />

import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { SentinelError } from "../domain/error.js";
import { TaskStateSchema, type TaskState } from "../domain/task.js";

export class TaskStore {
  constructor(private readonly repositoryRoot: string) {}

  async create(state: TaskState): Promise<void> {
    const validated = parseForWrite(state);
    await this.assertSafeStoragePath(validated.id, "PERSISTENCE_FAILED", true);
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
    await this.assertSafeStoragePath(taskId, "STATE_CORRUPT", false);
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
      assertRecoverableState(state);
      return state;
    } catch (error) {
      throw corruptStateError("Task state is not valid.", taskId, error);
    }
  }

  async save(state: TaskState): Promise<void> {
    const validated = parseForWrite(state);
    await this.assertSafeStoragePath(validated.id, "PERSISTENCE_FAILED", false);
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
      await syncDirectoryBestEffort(directory);
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

  private async assertSafeStoragePath(taskId: string, code: "PERSISTENCE_FAILED" | "STATE_CORRUPT", createParents: boolean): Promise<void> {
    const repositoryRoot = resolve(this.repositoryRoot);
    const storageRoot = join(repositoryRoot, ".sentinelloop", "tasks");
    if (createParents) await mkdir(storageRoot, { recursive: true });
    await assertNoSymlinkBetween(repositoryRoot, storageRoot, taskId, code);
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

async function assertNoSymlinkBetween(
  repositoryRoot: string,
  storageRoot: string,
  taskId: string,
  code: "PERSISTENCE_FAILED" | "STATE_CORRUPT"
): Promise<void> {
  let rootReal: string;
  try {
    rootReal = await realpath(repositoryRoot);
  } catch (error) {
    throw new SentinelError({ code, message: "Repository root cannot be resolved for storage.", detail: { taskId }, cause: error });
  }

  const candidates = [join(repositoryRoot, ".sentinelloop"), storageRoot, join(storageRoot, taskId)];
  for (const candidate of candidates) {
    try {
      const stat = await lstat(candidate);
      if (stat.isSymbolicLink()) throw new SentinelError({ code, message: "Task storage path cannot traverse a symbolic link.", detail: { taskId } });
      const candidateReal = await realpath(candidate);
      if (!isWithin(rootReal, candidateReal)) throw new SentinelError({ code, message: "Task storage path escapes the repository.", detail: { taskId } });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") break;
      if (error instanceof SentinelError) throw error;
      throw new SentinelError({ code, message: "Task storage ancestry cannot be verified.", detail: { taskId }, cause: error });
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform === "win32" && isNodeError(error) && ["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP"].includes(error.code ?? "")) return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertSafeTaskId(taskId: string, code: "PERSISTENCE_FAILED" | "STATE_CORRUPT"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
    throw new SentinelError({ code, message: "Task ID is not a safe path segment.", detail: { taskId } });
  }
}

function assertRecoverableState(state: TaskState): void {
  if (state.phase === "PAUSED" && state.resumePhase === null) {
    throw new Error("PAUSED state has no active resume phase.");
  }
  if (state.phase === "AWAITING_APPROVAL") {
    if (state.pendingApproval === null || state.resumePhase === null) {
      throw new Error("AWAITING_APPROVAL state is missing approval recovery context.");
    }
    if (state.pendingApproval.resumePhase !== state.resumePhase || state.pendingApproval.baselineVersion !== state.baselineVersion) {
      throw new Error("Approval context does not match the persisted resume state.");
    }
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

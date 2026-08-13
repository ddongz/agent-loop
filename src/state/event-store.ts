/// <reference types="node" />

import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { SentinelError } from "../domain/error.js";
import { TaskEventSchema, type TaskEvent } from "../domain/task.js";

export type NewTaskEvent = Omit<TaskEvent, "sequence">;

export class EventStore {
  constructor(private readonly repositoryRoot: string) {}

  async append(taskId: string, input: NewTaskEvent): Promise<TaskEvent> {
    if ("sequence" in input) throw corruptEventError("Callers cannot assign event sequence.", taskId);

    const existing = await this.list(taskId);
    const event = parseEvent({ ...input, sequence: existing.length + 1 }, taskId);
    validateEventSemantics(event, taskId);
    validateEventSequence([...existing, event], taskId);

    const directory = this.taskDirectory(taskId);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await mkdir(directory, { recursive: true });
      handle = await open(this.eventsPath(taskId), "a");
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      return event;
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      throw new SentinelError({
        code: "PERSISTENCE_FAILED",
        message: "Could not append task event.",
        detail: { taskId },
        cause: error
      });
    }
  }

  async list(taskId: string): Promise<TaskEvent[]> {
    assertSafeTaskId(taskId);
    await this.assertSafeStoragePath(taskId);
    await this.assertTaskExists(taskId);
    let contents: string;
    try {
      contents = await readFile(this.eventsPath(taskId), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw new SentinelError({
        code: "PERSISTENCE_FAILED",
        message: "Could not read task events.",
        detail: { taskId },
        cause: error
      });
    }

    if (contents.length === 0) return [];
    const lines = contents.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.some((line) => line.trim().length === 0)) {
      throw corruptEventError("Task event log contains an empty row.", taskId);
    }

    const events = lines.map((line) => {
      try {
        return parseEvent(JSON.parse(line), taskId);
      } catch (error) {
        if (error instanceof SentinelError) throw error;
        throw corruptEventError("Task event log contains invalid JSON.", taskId, error);
      }
    });
    for (const event of events) validateEventSemantics(event, taskId);
    validateEventSequence(events, taskId);
    return events;
  }

  private taskDirectory(taskId: string): string {
    return join(this.repositoryRoot, ".sentinelloop", "tasks", taskId);
  }

  private eventsPath(taskId: string): string {
    return join(this.taskDirectory(taskId), "events.jsonl");
  }

  private async assertTaskExists(taskId: string): Promise<void> {
    try {
      await access(join(this.taskDirectory(taskId), "state.json"), constants.F_OK);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new SentinelError({
          code: "TASK_NOT_FOUND",
          message: `Task ${taskId} was not found.`,
          detail: { taskId },
          cause: error
        });
      }
      throw new SentinelError({
        code: "PERSISTENCE_FAILED",
        message: "Could not check task state before reading events.",
        detail: { taskId },
        cause: error
      });
    }
  }

  private async assertSafeStoragePath(taskId: string): Promise<void> {
    const repositoryRoot = resolve(this.repositoryRoot);
    let rootReal: string;
    try {
      rootReal = await realpath(repositoryRoot);
    } catch (error) {
      throw corruptEventError("Repository root cannot be resolved for storage.", taskId, error);
    }

    const storageRoot = join(repositoryRoot, ".sentinelloop", "tasks");
    for (const candidate of [join(repositoryRoot, ".sentinelloop"), storageRoot, join(storageRoot, taskId)]) {
      try {
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink()) throw corruptEventError("Task storage path cannot traverse a symbolic link.", taskId);
        const candidateReal = await realpath(candidate);
        const path = relative(rootReal, candidateReal);
        if (path !== "" && (isAbsolute(path) || path === ".." || path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) {
          throw corruptEventError("Task storage path escapes the repository.", taskId);
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") break;
        if (error instanceof SentinelError) throw error;
        throw corruptEventError("Task storage ancestry cannot be verified.", taskId, error);
      }
    }
  }
}

function parseEvent(value: unknown, taskId: string): TaskEvent {
  const result = TaskEventSchema.safeParse(value);
  if (!result.success) throw corruptEventError("Task event does not match its schema.", taskId, result.error);
  if (result.data.taskId !== taskId) throw corruptEventError("Task event belongs to another task.", taskId);
  return result.data;
}

function validateEventSequence(events: readonly TaskEvent[], taskId: string): void {
  const ids = new Set<string>();
  let priorTimestamp = Number.NEGATIVE_INFINITY;
  events.forEach((event, index) => {
    if (event.sequence !== index + 1) throw corruptEventError("Task event sequence is not contiguous.", taskId);
    if (ids.has(event.id)) throw corruptEventError("Task event IDs are not unique.", taskId);
    ids.add(event.id);
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < priorTimestamp) throw corruptEventError("Task event timestamps are not nondecreasing.", taskId);
    priorTimestamp = timestamp;
  });
}

function validateEventSemantics(event: TaskEvent, taskId: string): void {
  if (event.type === "TASK_CREATED" && (event.phaseBefore !== null || event.phaseAfter !== "PRECHECK")) {
    throw corruptEventError("TASK_CREATED must enter PRECHECK from no prior phase.", taskId);
  }
  if (event.type === "PHASE_CHANGED" && (event.phaseBefore === null || event.phaseAfter === null)) {
    throw corruptEventError("PHASE_CHANGED requires both phases.", taskId);
  }
  const actionEvents: readonly TaskEvent["type"][] = [
    "ACTION_REQUESTED", "POLICY_DECIDED", "ACTION_COMPLETED", "APPROVAL_REQUESTED", "APPROVAL_RESOLVED"
  ];
  if (actionEvents.includes(event.type) && event.actionId === null) {
    throw corruptEventError(`${event.type} requires an action ID.`, taskId);
  }
  if (!actionEvents.includes(event.type) && event.actionId !== null) {
    throw corruptEventError(`${event.type} requires an explicit null action ID.`, taskId);
  }
  if (event.type !== "ACTION_COMPLETED" && event.observationActionId !== null) {
    throw corruptEventError(`${event.type} requires an explicit null observation action ID.`, taskId);
  }
  if (event.type === "ACTION_COMPLETED" && event.observationActionId !== null && event.observationActionId !== event.actionId) {
    throw corruptEventError("ACTION_COMPLETED observation must refer to the same action.", taskId);
  }
}

function corruptEventError(message: string, taskId: string, cause?: unknown): SentinelError {
  return new SentinelError({ code: "STATE_CORRUPT", message, detail: { taskId }, cause });
}

function assertSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) {
    throw corruptEventError("Task ID is not a safe path segment.", taskId);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

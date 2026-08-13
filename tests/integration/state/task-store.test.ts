import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SentinelError } from "../../../src/domain/error.js";
import { TaskStateSchema, type TaskEvent, type TaskState } from "../../../src/domain/task.js";
import { EventStore, type NewTaskEvent } from "../../../src/state/event-store.js";
import { TaskStore } from "../../../src/state/task-store.js";

const TIMESTAMPS = [
  "2026-08-14T00:00:00.000Z",
  "2026-08-14T00:01:00.000Z",
  "2026-08-14T00:02:00.000Z"
] as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sentinelloop-state-"));
  roots.push(root);
  return root;
}

function makeState(): TaskState {
  return TaskStateSchema.parse({
    schemaVersion: 1,
    id: "t1",
    repositoryRoot: "C:/repository",
    requirement: "Persist and recover this task",
    phase: "PRECHECK",
    resumePhase: null,
    iteration: 2,
    budget: { maxIterations: 8, maxDurationMs: 1_800_000, maxTokens: 12_000, maxCostUsd: 1.5 },
    usage: { iterations: 2, elapsedMs: 400, inputTokens: 100, outputTokens: 50, costUsd: 0.02 },
    validationPlan: [],
    protectedTests: [],
    baselineVersion: 0,
    pendingApproval: null,
    lastFeedback: null,
    lastError: null,
    lastCodeChangeAt: null,
    finalValidationAt: null,
    finalValidation: null,
    createdAt: TIMESTAMPS[0],
    updatedAt: TIMESTAMPS[1]
  });
}

function event(overrides: Partial<NewTaskEvent> = {}): NewTaskEvent {
  return {
    schemaVersion: 1,
    id: "e1",
    taskId: "t1",
    type: "TASK_CREATED",
    timestamp: TIMESTAMPS[0],
    phaseBefore: null,
    phaseAfter: "PRECHECK",
    actionId: null,
    observationActionId: null,
    causationEventId: null,
    payload: {},
    ...overrides
  };
}

describe("durable task state", () => {
  it("recovers schema-validated state and events through fresh store instances", async () => {
    const root = await makeRoot();
    const state = makeState();
    const tasks = new TaskStore(root);
    const events = new EventStore(root);

    await tasks.create(state);
    await events.append("t1", event());
    await events.append("t1", event({
      id: "e2",
      type: "PHASE_CHANGED",
      timestamp: TIMESTAMPS[1],
      phaseBefore: "PRECHECK",
      phaseAfter: "ANALYZE_REQUIREMENT"
    }));

    await expect(new TaskStore(root).load("t1")).resolves.toEqual(state);
    await expect(new EventStore(root).list("t1")).resolves.toMatchObject([
      { id: "e1", sequence: 1 },
      { id: "e2", sequence: 2 }
    ] satisfies Partial<TaskEvent>[]);
  });

  it("atomically replaces state without leaving its same-directory temporary file", async () => {
    const root = await makeRoot();
    const store = new TaskStore(root);
    const initial = makeState();
    const updated = { ...initial, phase: "ANALYZE_REQUIREMENT", updatedAt: TIMESTAMPS[2] } as TaskState;

    await store.create(initial);
    await store.save(updated);

    await expect(new TaskStore(root).load("t1")).resolves.toEqual(updated);
    await expect(readFile(join(root, ".sentinelloop", "tasks", "t1", "state.json.tmp"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects corrupted state rather than inventing recovery defaults", async () => {
    const root = await makeRoot();
    const store = new TaskStore(root);
    await store.create(makeState());
    await writeFile(join(root, ".sentinelloop", "tasks", "t1", "state.json"), "{not json", "utf8");

    await expect(store.load("t1")).rejects.toMatchObject<Partial<SentinelError>>({ code: "STATE_CORRUPT" });
  });

  it("does not let save or event access silently create an unknown task", async () => {
    const root = await makeRoot();
    const state = makeState();

    await expect(new TaskStore(root).save(state)).rejects.toMatchObject<Partial<SentinelError>>({ code: "TASK_NOT_FOUND" });
    await expect(new EventStore(root).list("t1")).rejects.toMatchObject<Partial<SentinelError>>({ code: "TASK_NOT_FOUND" });
    await expect(new EventStore(root).append("t1", event())).rejects.toMatchObject<Partial<SentinelError>>({ code: "TASK_NOT_FOUND" });
  });

  it("rejects task IDs that could escape the internal task directory", async () => {
    const root = await makeRoot();
    const unsafe = { ...makeState(), id: "../outside" } as TaskState;

    await expect(new TaskStore(root).create(unsafe)).rejects.toMatchObject<Partial<SentinelError>>({ code: "PERSISTENCE_FAILED" });
    await expect(new TaskStore(root).load("../outside")).rejects.toMatchObject<Partial<SentinelError>>({ code: "STATE_CORRUPT" });
    await expect(new EventStore(root).list("../outside")).rejects.toMatchObject<Partial<SentinelError>>({ code: "STATE_CORRUPT" });
  });

  it("rejects noncontiguous, duplicate, cross-task, and time-reversing event logs", async () => {
    const corruptions: TaskEvent[][] = [
      [{ ...event(), sequence: 2 }],
      [{ ...event(), sequence: 1 }, { ...event({ timestamp: TIMESTAMPS[1] }), sequence: 2 }],
      [{ ...event(), sequence: 1 }, { ...event({ id: "e2", taskId: "other", timestamp: TIMESTAMPS[1] }), sequence: 2 }],
      [{ ...event({ timestamp: TIMESTAMPS[1] }), sequence: 1 }, { ...event({ id: "e2" }), sequence: 2 }]
    ];

    for (const rows of corruptions) {
      const root = await makeRoot();
      const tasks = new TaskStore(root);
      await tasks.create(makeState());
      await writeFile(
        join(root, ".sentinelloop", "tasks", "t1", "events.jsonl"),
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
        "utf8"
      );

      await expect(new EventStore(root).list("t1")).rejects.toMatchObject<Partial<SentinelError>>({ code: "STATE_CORRUPT" });
    }
  });

  it("validates event semantics while assigning sequence itself", async () => {
    const root = await makeRoot();
    await new TaskStore(root).create(makeState());
    const store = new EventStore(root);

    await expect(store.append("t1", event({
      id: "e2",
      type: "PHASE_CHANGED",
      phaseBefore: null,
      phaseAfter: "ANALYZE_REQUIREMENT"
    }))).rejects.toMatchObject<Partial<SentinelError>>({ code: "STATE_CORRUPT" });

    await expect(store.append("t1", event({ sequence: 99 } as Partial<NewTaskEvent>))).rejects.toMatchObject<Partial<SentinelError>>({ code: "STATE_CORRUPT" });
  });
});

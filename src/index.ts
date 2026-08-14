#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { NodeCliIO } from "./cli/io.js";
import { createProgram, type CliProgram } from "./cli/program.js";
import { PlatformCredentialStore } from "./credentials/platform-store.js";
import { SentinelError } from "./domain/error.js";
import { EventStore } from "./state/event-store.js";
import { TaskStore } from "./state/task-store.js";

export * from "./cli/exit-codes.js";
export * from "./cli/io.js";
export * from "./cli/program.js";
export * from "./config/config-store.js";
export * from "./config/schema.js";
export * from "./credentials/memory-store.js";
export * from "./credentials/platform-store.js";
export * from "./credentials/redaction.js";
export * from "./credentials/types.js";
export * from "./reporting/report-generator.js";

export function createDefaultProgram(repositoryRoot = process.cwd()): CliProgram {
  const unavailableRuntime = async (): Promise<never> => {
    throw new SentinelError({
      code: "INVALID_CONFIG",
      message: "Task runtime is not configured; provide a profile-aware orchestrator composition before run or resume.",
    });
  };
  return createProgram({
    io: new NodeCliIO(),
    credentials: new PlatformCredentialStore(),
    orchestrator: {
      start: unavailableRuntime,
      step: unavailableRuntime,
      resume: unavailableRuntime,
    },
    taskStore: new TaskStore(repositoryRoot),
    eventStore: new EventStore(repositoryRoot),
    cwd: () => repositoryRoot,
    taskId: randomUUID,
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return createDefaultProgram().execute(argv);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main();
}

#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { NodeCliIO } from "./cli/io.js";
import { createProgram, type CliProgram } from "./cli/program.js";
import { PlatformCredentialStore } from "./credentials/platform-store.js";
import type { RedConfirmationInput } from "./orchestrator/task-orchestrator.js";
import { ProductionRuntime } from "./runtime/production-runtime.js";
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
export * from "./runtime/production-runtime.js";

export function createDefaultProgram(repositoryRoot = process.cwd()): CliProgram {
  const io = new NodeCliIO();
  const credentials = new PlatformCredentialStore();
  const orchestrator = new ProductionRuntime({
    repositoryRoot,
    credentials,
    confirmRed: (input) => io.confirm(redConfirmationPrompt(input)),
  });
  return createProgram({
    io,
    credentials,
    orchestrator,
    taskStore: new TaskStore(repositoryRoot),
    eventStore: new EventStore(repositoryRoot),
    cwd: () => repositoryRoot,
    taskId: randomUUID,
  });
}

function redConfirmationPrompt(input: RedConfirmationInput): string {
  const mappings = input.requirementToTests.map(({ testPath, testNames }) =>
    `- ${testPath}: ${testNames.length === 0 ? "unmapped test" : testNames.join(", ")}`,
  );
  return [
    "Confirm this failing-test baseline?",
    input.failureSummary,
    ...mappings,
  ].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return createDefaultProgram().execute(argv);
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  process.exitCode = await main();
}

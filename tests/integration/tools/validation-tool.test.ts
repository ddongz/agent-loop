import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ObservationSchema } from "../../../src/domain/action.js";
import { ValidationResultSchema } from "../../../src/domain/validation.js";
import { createValidationTool, runValidationCommand } from "../../../src/tools/validation-tool.js";
import { createTempRepository } from "../../helpers/temp-repository.js";

describe("validation tool", () => {
  it("bounds each captured stream at 64 KiB and records truncation", async () => {
    const root = await createTempRepository();
    const scripts = join(root, "scripts with spaces");
    await mkdir(scripts);
    const script = join(scripts, "大量 output.mjs");
    await writeFile(script, "process.stdout.write('o'.repeat(70_000)); process.stderr.write('e'.repeat(70_000));\n", "utf8");
    const tool = createValidationTool({
      workspaceRoot: root,
      validationPlan: [{ validator: "test", executable: process.execPath, args: [script], timeoutMs: 5_000, enabled: true }],
    });

    const observation = await tool.execute(
      { version: 1, id: "bounded", rationale: "Run tests.", type: "run_validation", validator: "test" },
      new AbortController().signal,
    );
    const [result] = JSON.parse(observation.output) as Array<{ stdoutSummary: string; stderrSummary: string; stdoutTruncated: boolean; stderrTruncated: boolean }>;

    expect(Buffer.byteLength(result.stdoutSummary)).toBe(65_536);
    expect(Buffer.byteLength(result.stderrSummary)).toBe(65_536);
    expect(result).toMatchObject({ stdoutTruncated: true, stderrTruncated: true });
  });

  it("truncates validation streams at complete UTF-8 boundaries", async () => {
    const root = await createTempRepository();
    const script = join(root, "unicode-output.mjs");
    await writeFile(script, "process.stdout.write('a'.repeat(65_535) + '界tail');\n", "utf8");
    const tool = validationTool(root, process.execPath, [script]);

    const observation = await execute(tool, "unicode-output");
    const [result] = JSON.parse(observation.output) as Array<{ stdoutSummary: string; stdoutTruncated: boolean }>;

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdoutSummary).not.toContain("�");
    expect(Buffer.byteLength(result.stdoutSummary)).toBe(65_535);
  });

  it("kills an aborted validation and returns a timeout observation", async () => {
    const root = await createTempRepository();
    const script = join(root, "wait.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n", "utf8");
    const controller = new AbortController();
    const tool = createValidationTool({
      workspaceRoot: root,
      validationPlan: [{ validator: "test", executable: process.execPath, args: [script], timeoutMs: 30_000, enabled: true }],
    });
    setTimeout(() => controller.abort(), 50);

    const observation = await tool.execute(
      { version: 1, id: "abort", rationale: "Run tests.", type: "run_validation", validator: "test" },
      controller.signal,
    );

    expect(observation).toMatchObject({ status: "failed", error: { code: "TOOL_TIMEOUT" } });
  });

  it("represents a nonzero validator exit as a successful tool observation with failed validation", async () => {
    const root = await createTempRepository();
    const script = join(root, "fail.mjs");
    await writeFile(script, "process.stderr.write('assertion failed'); process.exitCode = 7;\n", "utf8");
    const tool = validationTool(root, process.execPath, [script]);

    const observation = await execute(tool, "nonzero");
    const [result] = JSON.parse(observation.output) as unknown[];

    expect(observation).toMatchObject({ status: "succeeded", error: null });
    expect(ValidationResultSchema.parse(result)).toMatchObject({
      validator: "test",
      status: "failed",
      exitCode: 7,
      stderrSummary: "assertion failed",
      issues: [],
    });
  });

  it("normalizes spawn errors as validation infrastructure failures", async () => {
    const root = await createTempRepository();
    const tool = validationTool(root, join(root, "missing executable"), []);

    const observation = await execute(tool, "spawn-error");

    expect(ObservationSchema.parse(observation)).toMatchObject({ status: "failed", error: { code: "VALIDATION_INFRASTRUCTURE" } });
    expect(observation.error?.message).not.toContain("missing executable");
  });

  it("passes metacharacters and non-ASCII paths as literal arguments without a shell", async () => {
    const root = await createTempRepository();
    const scripts = join(root, "路径 with spaces");
    await mkdir(scripts);
    const script = join(scripts, "argv.mjs");
    const injected = join(root, "injected.txt");
    await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", "utf8");
    const argument = `value; echo owned > ${injected}`;
    const tool = validationTool(root, process.execPath, [script, argument]);

    const observation = await execute(tool, "args");
    const [result] = JSON.parse(observation.output) as Array<{ stdoutSummary: string }>;

    expect(JSON.parse(result.stdoutSummary)).toEqual([argument]);
    await expect(readFile(injected)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops an all-validation run after the first nonzero result", async () => {
    const root = await createTempRepository();
    const marker = join(root, "second-ran.txt");
    const first = join(root, "first.mjs");
    const second = join(root, "second.mjs");
    await writeFile(first, "process.exitCode = 1;\n", "utf8");
    await writeFile(second, `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'ran'));\n`, "utf8");
    const tool = createValidationTool({
      workspaceRoot: root,
      validationPlan: [
        { validator: "test", executable: process.execPath, args: [first], timeoutMs: 5_000, enabled: true },
        { validator: "typecheck", executable: process.execPath, args: [second], timeoutMs: 5_000, enabled: true },
      ],
    });

    const observation = await tool.execute(
      { version: 1, id: "all", rationale: "Run all validation.", type: "run_validation", validator: "all" },
      new AbortController().signal,
    );

    const results = JSON.parse(observation.output) as unknown[];
    expect(results).toHaveLength(1);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("times out a long-running command using its discovered deadline", async () => {
    const root = await createTempRepository();
    const script = join(root, "timeout.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n", "utf8");
    const tool = createValidationTool({
      workspaceRoot: root,
      validationPlan: [{ validator: "test", executable: process.execPath, args: [script], timeoutMs: 1_000, enabled: true }],
    });

    const observation = await execute(tool, "deadline");

    expect(observation).toMatchObject({ status: "failed", error: { code: "TOOL_TIMEOUT" } });
    expect(observation.durationMs).toBeLessThan(4_000);
  });

  it("terminates descendants when an AbortSignal cancels validation", async () => {
    const root = await createTempRepository();
    const marker = join(root, "descendant-survived.txt");
    const child = join(root, "child.mjs");
    const parent = join(root, "parent.mjs");
    await writeFile(child, `setTimeout(() => import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'survived')), 700);\nsetInterval(() => {}, 1000);\n`, "utf8");
    await writeFile(parent, `import { spawn } from 'node:child_process'; spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);\n`, "utf8");
    const controller = new AbortController();
    const tool = validationTool(root, process.execPath, [parent], 10_000);
    setTimeout(() => controller.abort(), 100);

    const observation = await tool.execute(
      { version: 1, id: "tree", rationale: "Run tests.", type: "run_validation", validator: "test" },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(observation).toMatchObject({ status: "failed", error: { code: "TOOL_TIMEOUT" } });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies an external close signal as validation infrastructure failure", async () => {
    const root = await createTempRepository();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.kill = () => true;
    const spawnProcess = (() => child) as unknown as typeof import("node:child_process").spawn;

    const pending = runValidationCommand(
      root,
      { validator: "test", executable: "not-invoked", args: [], timeoutMs: 5_000, enabled: true },
      new AbortController().signal,
      spawnProcess,
    );
    queueMicrotask(() => {
      child.stdout.end("partial output");
      child.stderr.end();
      child.emit("close", null, "SIGTERM");
    });

    await expect(pending).resolves.toMatchObject({
      status: "infrastructure_error",
      exitCode: null,
      stdoutSummary: "partial output",
    });
  });
});

function validationTool(root: string, executable: string, args: string[], timeoutMs = 5_000) {
  return createValidationTool({
    workspaceRoot: root,
    validationPlan: [{ validator: "test", executable, args, timeoutMs, enabled: true }],
  });
}

async function execute(tool: ReturnType<typeof createValidationTool>, id: string) {
  return tool.execute(
    { version: 1, id, rationale: "Run tests.", type: "run_validation", validator: "test" },
    new AbortController().signal,
  );
}

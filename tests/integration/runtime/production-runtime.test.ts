import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigStore } from "../../../src/config/config-store.js";
import { MemoryCredentialStore } from "../../../src/credentials/memory-store.js";
import { ProductionRuntime } from "../../../src/runtime/production-runtime.js";

const execute = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProductionRuntime", () => {
  it("runs the governed red-test path and restores a paused task in a fresh runtime", async () => {
    const parent = await mkdtemp(join(tmpdir(), "sentinelloop-runtime-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "repository");
    const configPath = join(parent, "config.json");
    await mkdir(root);
    await mkdir(join(root, "tests"));
    await writeFile(join(root, ".gitignore"), ".sentinelloop/\n", "utf8");
    await writeFile(join(root, "package.json"), `${JSON.stringify({
      name: "runtime-fixture",
      version: "1.0.0",
      private: true,
      scripts: { test: "node tests/feature.test.js" },
    }, null, 2)}\n`, "utf8");
    await writeFile(join(root, "package-lock.json"), `${JSON.stringify({
      name: "runtime-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "runtime-fixture", version: "1.0.0" } },
    }, null, 2)}\n`, "utf8");
    await git(root, "init");
    await git(root, "config", "user.email", "runtime@example.invalid");
    await git(root, "config", "user.name", "SentinelLoop Runtime");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "fixture");

    await new ConfigStore(configPath).save({
      schemaVersion: 1,
      profiles: {
        default: {
          baseUrl: "https://provider.example.test/v1",
          model: "fixture-model",
          allowedHeaderNames: [],
          policies: { maxIterations: 4, maxDurationMs: 60_000 },
        },
      },
    });
    const credentials = new MemoryCredentialStore();
    await credentials.set("default", "opaque-runtime-credential");
    const responses = [
      actionResponse({
        version: 1,
        id: "create-red-test",
        type: "create_file",
        rationale: "Create the focused failing test.",
        path: "tests/feature.test.js",
        content: [
          "process.stderr.write('FAIL tests/feature.test.js > feature\\nAssertionError: expected 1 to be 2\\n tests/feature.test.js:1:1\\n');",
          "process.exitCode = 1;",
          "",
        ].join("\n"),
      }),
      actionResponse({
        version: 1,
        id: "confirm-red",
        type: "run_validation",
        rationale: "Confirm the target behavior is missing.",
        validator: "test",
      }),
      actionResponse({
        version: 1,
        id: "need-input",
        type: "request_clarification",
        rationale: "The implementation decision needs user input.",
        question: "Which validation message should be public?",
      }),
      actionResponse({
        version: 1,
        id: "need-input-again",
        type: "request_clarification",
        rationale: "Resume still needs the same user input.",
        question: "Which validation message should be public?",
      }),
    ];
    const providerBodies: string[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      providerBodies.push(String(init?.body));
      const body = responses.shift();
      if (body === undefined) throw new Error("No fake provider response remains.");
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    const options = { repositoryRoot: root, configPath, credentials, confirmRed: async () => true, fetch };
    const initialRuntime = new ProductionRuntime(options);

    let state = await initialRuntime.start({
      id: "runtime-task",
      repositoryRoot: root,
      requirement: "Add the feature without exposing opaque-runtime-credential.",
    });
    for (let count = 0; count < 8 && state.phase !== "PAUSED"; count += 1) {
      state = await initialRuntime.step(state.id);
    }
    expect(state.phase).toBe("PAUSED");
    expect(state.resumePhase).toBe("IMPLEMENT");
    expect(state.baselineVersion).toBe(1);
    expect(providerBodies.join("\n")).not.toContain("opaque-runtime-credential");
    expect(providerBodies.join("\n")).toContain("[REDACTED]");
    const firstProviderRequest = JSON.parse(providerBodies[0]!) as {
      tools: Array<{ function: { name: string; parameters: unknown } }>;
    };
    const createFileSchema = firstProviderRequest.tools.find(({ function: tool }) => tool.name === "create_file")?.function.parameters;
    expect(JSON.stringify(createFileSchema)).toContain('"path"');
    expect(JSON.stringify(createFileSchema)).toContain('"content"');

    const restoredRuntime = new ProductionRuntime(options);
    const resumed = await restoredRuntime.resume(state.id);
    expect(resumed.phase).toBe("IMPLEMENT");
    const pausedAgain = await restoredRuntime.step(state.id);
    expect(pausedAgain.phase).toBe("PAUSED");
  }, 30_000);
});

function actionResponse(action: Record<string, unknown>) {
  return {
    id: `response-${String(action.id)}`,
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call-${String(action.id)}`,
          type: "function",
          function: { name: action.type, arguments: JSON.stringify(action) },
        }],
      },
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execute("git", ["-C", root, ...args], { windowsHide: true });
}

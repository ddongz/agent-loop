import { describe, expect, it, vi } from "vitest";

import { ActionSchema, ObservationSchema, type Action, type Observation } from "../../../src/domain/action.js";
import type { JsonValue } from "../../../src/domain/error.js";
import { ApprovalManager } from "../../../src/governance/approval.js";
import { PolicyEngine } from "../../../src/governance/policy-engine.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import type { Tool } from "../../../src/tools/types.js";

describe("ToolRegistry", () => {
  it("does not execute a tool when policy denies the action", async () => {
    const execute = vi.fn<() => Promise<Observation>>();
    const tool: Tool = {
      type: "create_file",
      schema: ActionSchema,
      constraints: [],
      execute,
    };
    const registry = new ToolRegistry(new PolicyEngine(), [tool]);

    const observation = await registry.dispatch(
      {
        workspaceRoot: process.cwd(),
        phase: "ANALYZE_REQUIREMENT",
        protectedTests: [],
        baselineVersion: 0,
      },
      { version: 1, id: "denied", rationale: "Attempt a write.", type: "create_file", path: "src/no.ts", content: "no\n" },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(observation).toMatchObject({
      actionId: "denied",
      tool: "create_file",
      status: "denied",
      error: { code: "POLICY_DENIED" },
    });
  });

  it("denies dispatch when a tool cannot enforce a policy constraint", async () => {
    const execute = vi.fn<() => Promise<Observation>>();
    const tool: Tool = { type: "list_files", schema: ActionSchema, constraints: [], execute };
    const registry = new ToolRegistry(new PolicyEngine(), [tool]);

    const observation = await registry.dispatch(context(), action({ type: "list_files", id: "constraint", maxDepth: 1, maxEntries: 20 }));

    expect(execute).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: "denied", error: { code: "POLICY_DENIED" } });
  });

  it("converts malformed tool observations into a schema-valid infrastructure failure", async () => {
    const malformed = {
      actionId: "wrong",
      tool: "read_file",
      status: "succeeded",
      startedAt: "not-a-timestamp",
      durationMs: -1,
      output: "untrusted",
      truncated: false,
      error: null,
    } as Observation;
    const tool: Tool = { type: "read_file", schema: ActionSchema, constraints: [], execute: vi.fn(async () => malformed) };
    const registry = new ToolRegistry(new PolicyEngine(), [tool]);

    const observation = await registry.dispatch(context(), action({ type: "read_file", id: "normalize", path: "package.json", maxBytes: 100 }));

    expect(ObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation).toMatchObject({ actionId: "normalize", tool: "read_file", status: "failed", error: { code: "INTERNAL" } });
    expect(observation.output).not.toContain("untrusted");
  });

  it("reports unknown and malformed known actions without consulting policy or tools", async () => {
    const evaluate = vi.fn<PolicyEngine["evaluate"]>();
    const registry = new ToolRegistry({ evaluate }, []);

    const unknown = await registry.dispatch(context(), { version: 1, id: "unknown", rationale: "Try unknown.", type: "shell", command: "rm" });
    const invalid = await registry.dispatch(context(), { version: 1, id: "invalid", rationale: "Read.", type: "read_file" });

    expect(evaluate).not.toHaveBeenCalled();
    expect(unknown).toMatchObject({ actionId: "unknown", tool: "shell", status: "failed", error: { code: "UNKNOWN_ACTION" } });
    expect(invalid).toMatchObject({ actionId: "invalid", tool: "read_file", status: "failed", error: { code: "INVALID_ACTION" } });
  });

  it("returns approval_required before invoking a protected-write tool", async () => {
    const execute = vi.fn<() => Promise<Observation>>();
    const policy = { evaluate: vi.fn(async () => ({ kind: "REQUIRE_APPROVAL", reasonCode: "PROTECTED_TEST_MUTATION" } as const)) };
    const registry = new ToolRegistry(policy, [{ type: "create_file", schema: ActionSchema, constraints: [], execute }]);

    const observation = await registry.dispatch(context(), action({ type: "create_file", id: "approval", path: "tests/a.test.ts", content: "x" }));

    expect(execute).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: "approval_required", error: { code: "APPROVAL_REQUIRED" } });
  });

  it("consults the selected tool schema before execution", async () => {
    const execute = vi.fn<() => Promise<Observation>>();
    const schema = ActionSchema.refine(({ id }) => id !== "schema-blocked", "blocked by tool schema");
    const registry = new ToolRegistry(new PolicyEngine(), [{ type: "read_file", schema, constraints: [], execute }]);

    const observation = await registry.dispatch(context(), action({ type: "read_file", id: "schema-blocked", path: "package.json", maxBytes: 100 }));

    expect(execute).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: "failed", error: { code: "INVALID_ACTION" } });
  });

  it("centrally redacts a schema-valid observation returned by a tool", async () => {
    const tool: Tool = {
      type: "read_file",
      schema: ActionSchema,
      constraints: [],
      execute: vi.fn(async (input) => ({
        actionId: input.id,
        tool: input.type,
        status: "succeeded",
        startedAt: new Date().toISOString(),
        durationMs: 1,
        output: "token=secret",
        truncated: false,
        error: null,
      })),
    };
    const redact = (value: JsonValue): JsonValue => {
      if (typeof value === "string") return value.replaceAll("secret", "[REDACTED]");
      return value;
    };
    const registry = new ToolRegistry(new PolicyEngine(), [tool], redact);

    const observation = await registry.dispatch(context(), action({ type: "read_file", id: "redact", path: "package.json", maxBytes: 100 }));

    expect(observation.output).toBe("token=[REDACTED]");
  });

  it("does not consume approval when the approved tool is missing", async () => {
    const approved = approvedWrite("missing-tool");
    const registry = new ToolRegistry(new PolicyEngine(), []);

    const observation = await registry.dispatch(approved.context, approved.action);

    expect(observation).toMatchObject({ status: "failed", error: { code: "UNKNOWN_ACTION" } });
    expect(approved.approvals.consume(approved.action, 2)).toEqual({ ok: true, reasonCode: "ONE_TIME_APPROVAL_CONSUMED" });
  });

  it("does not consume approval when the selected tool schema rejects input", async () => {
    const approved = approvedWrite("invalid-tool-input");
    const execute = vi.fn<() => Promise<Observation>>();
    const registry = new ToolRegistry(new PolicyEngine(), [{
      type: "create_file",
      schema: ActionSchema.refine(() => false, "tool-specific rejection"),
      constraints: [],
      execute,
    }]);

    const observation = await registry.dispatch(approved.context, approved.action);

    expect(execute).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: "failed", error: { code: "INVALID_ACTION" } });
    expect(approved.approvals.consume(approved.action, 2)).toEqual({ ok: true, reasonCode: "ONE_TIME_APPROVAL_CONSUMED" });
  });

  it("consumes an exact approval immediately before executing the validated tool", async () => {
    const approved = approvedWrite("actual-dispatch");
    let approvalSeenByTool: ReturnType<ApprovalManager["consume"]> | null = null;
    const tool: Tool = {
      type: "create_file",
      schema: ActionSchema,
      constraints: [],
      execute: vi.fn(async (input) => {
        approvalSeenByTool = approved.approvals.consume(input, 2);
        return successfulObservation(input);
      }),
    };
    const registry = new ToolRegistry(new PolicyEngine(), [tool]);

    const observation = await registry.dispatch(approved.context, approved.action);

    expect(observation.status).toBe("succeeded");
    expect(approvalSeenByTool).toEqual({ ok: false, reasonCode: "APPROVAL_REPLAYED" });
  });

  it("does not consume approval when a policy constraint is unsupported", async () => {
    const approved = approvedWrite("unsupported-constraint");
    const execute = vi.fn<() => Promise<Observation>>();
    const policy = {
      evaluate: vi.fn(async () => ({
        kind: "ALLOW",
        reasonCode: "ONE_TIME_APPROVAL_GRANTED",
        constraints: [{ kind: "EXCLUDE_SENSITIVE_PATHS_RECURSIVELY" }],
      } as const)),
    };
    const registry = new ToolRegistry(policy, [{ type: "create_file", schema: ActionSchema, constraints: [], execute }]);

    const observation = await registry.dispatch(approved.context, approved.action);

    expect(execute).not.toHaveBeenCalled();
    expect(observation).toMatchObject({ status: "denied", error: { code: "POLICY_DENIED" } });
    expect(approved.approvals.consume(approved.action, 2)).toEqual({ ok: true, reasonCode: "ONE_TIME_APPROVAL_CONSUMED" });
  });
});

function context() {
  return { workspaceRoot: process.cwd(), phase: "ANALYZE_REQUIREMENT" as const, protectedTests: [], baselineVersion: 0 };
}

function action(overrides: Record<string, unknown>): Action {
  const type = overrides.type;
  const base = { version: 1 as const, id: "action", rationale: "Exercise registry.", ...overrides };
  if (type === "read_file") return base as Action;
  if (type === "list_files") return base as Action;
  if (type === "create_file") return base as Action;
  throw new Error("Unsupported test action");
}

function approvedWrite(id: string) {
  const timestamps = [
    "2026-08-14T12:00:00.000Z",
    "2026-08-14T12:00:01.000Z",
    "2026-08-14T12:00:02.000Z",
  ];
  const approvals = new ApprovalManager(() => {
    const timestamp = timestamps.shift();
    if (timestamp === undefined) throw new Error("Test clock exhausted.");
    return timestamp;
  });
  const approvedAction = action({
    type: "create_file",
    id,
    path: "tests/unit/tools/registry.test.ts",
    content: "approved content\n",
  });
  approvals.request(approvedAction, 2);
  approvals.approve(approvedAction.id);
  return {
    action: approvedAction,
    approvals,
    context: {
      workspaceRoot: process.cwd(),
      phase: "IMPLEMENT" as const,
      protectedTests: ["tests/unit/tools/registry.test.ts"],
      baselineVersion: 2,
      approvals,
    },
  };
}

function successfulObservation(input: Action): Observation {
  return {
    actionId: input.id,
    tool: input.type,
    status: "succeeded",
    startedAt: new Date().toISOString(),
    durationMs: 1,
    output: "ok",
    truncated: false,
    error: null,
  };
}

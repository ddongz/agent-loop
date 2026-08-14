import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Action } from "../../../src/domain/action.js";
import { ApprovalManager } from "../../../src/governance/approval.js";
import { PolicyEngine } from "../../../src/governance/policy-engine.js";
import { createTempRepository } from "../../helpers/temp-repository.js";

const roots: string[] = [];

async function repository(): Promise<string> {
  const root = await createTempRepository("policy repo 测试");
  roots.push(dirname(root));
  await mkdir(`${root}/tests`, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function createFile(id: string, path: string, content = "content\n"): Action {
  return { version: 1, id, rationale: "Implement the requested behavior", type: "create_file", path, content };
}

function clock(...timestamps: string[]): () => string {
  let index = 0;
  return () => {
    const timestamp = timestamps[index];
    if (timestamp === undefined) throw new Error("Test clock exhausted.");
    index += 1;
    return timestamp;
  };
}

describe("PolicyEngine", () => {
  it("denies production writes while tests are being generated", async () => {
    const root = await repository();
    const policy = new PolicyEngine();

    await expect(
      policy.evaluate(
        { workspaceRoot: root, phase: "GENERATE_TESTS", protectedTests: [], baselineVersion: 0 },
        createFile("production-write", "src/feature.ts"),
      ),
    ).resolves.toEqual({ kind: "DENY", reasonCode: "WRITE_OUTSIDE_TEST_PATTERN" });
  });

  it.each(["tests/feature.test.ts", "src/feature.spec.ts", "src/__tests__/feature.ts"])(
    "allows test-pattern write %s during test generation",
    async (path) => {
      const root = await repository();
      const policy = new PolicyEngine();

      await expect(
        policy.evaluate(
          { workspaceRoot: root, phase: "GENERATE_TESTS", protectedTests: [], baselineVersion: 0 },
          createFile("test-write", path),
        ),
      ).resolves.toEqual({ kind: "ALLOW", reasonCode: "PHASE_ACTION_ALLOWED" });
    },
  );

  it("denies sensitive files before considering phase permissions", async () => {
    const root = await repository();
    const policy = new PolicyEngine();

    await expect(
      policy.evaluate(
        { workspaceRoot: root, phase: "IMPLEMENT", protectedTests: [], baselineVersion: 1 },
        createFile("sensitive", ".git/config"),
      ),
    ).resolves.toEqual({ kind: "DENY", reasonCode: "SENSITIVE_PATH" });
  });

  it("denies a nested sensitive path before considering phase permissions", async () => {
    const root = await repository();

    await expect(
      new PolicyEngine().evaluate(
        { workspaceRoot: root, phase: "IMPLEMENT", protectedTests: [], baselineVersion: 1 },
        createFile("nested-sensitive", "fixtures/.env.local/secret.ts"),
      ),
    ).resolves.toEqual({ kind: "DENY", reasonCode: "SENSITIVE_PATH" });
  });

  it.each([
    { version: 1, id: "root-list", rationale: "Explore the repository", type: "list_files" as const },
    { version: 1, id: "root-search", rationale: "Find relevant code", type: "search_files" as const, query: "feature" },
  ])("allows pathless $type while requiring recursive sensitive-path exclusion", async (action) => {
    const root = await repository();

    await expect(
      new PolicyEngine().evaluate(
        { workspaceRoot: root, phase: "ANALYZE_REQUIREMENT", protectedTests: [], baselineVersion: 0 },
        action,
      ),
    ).resolves.toEqual({
      kind: "ALLOW",
      reasonCode: "PHASE_ACTION_ALLOWED",
      constraints: [{ kind: "EXCLUDE_SENSITIVE_PATHS_RECURSIVELY" }],
    });
  });

  it("denies path escapes with a stable policy reason", async () => {
    const root = await repository();
    const policy = new PolicyEngine();

    await expect(
      policy.evaluate(
        { workspaceRoot: root, phase: "IMPLEMENT", protectedTests: [], baselineVersion: 1 },
        createFile("escape", "../outside.ts"),
      ),
    ).resolves.toEqual({ kind: "DENY", reasonCode: "PATH_ESCAPE" });
  });

  it("requires approval for a protected-test mutation after freezing before any dispatch", async () => {
    const root = await repository();
    const policy = new PolicyEngine();
    const action = createFile("protected", "tests\\feature.test.ts", "weaker assertion\n");

    await expect(
      policy.evaluate(
        {
          workspaceRoot: root,
          phase: "IMPLEMENT",
          protectedTests: ["tests/feature.test.ts"],
          baselineVersion: 2,
        },
        action,
      ),
    ).resolves.toEqual({ kind: "REQUIRE_APPROVAL", reasonCode: "PROTECTED_TEST_MUTATION" });
  });

  it("consumes an exact approved action once and denies replay", async () => {
    const root = await repository();
    const approvals = new ApprovalManager(clock(
      "2026-08-14T12:00:00.000Z",
      "2026-08-14T12:00:01.000Z",
      "2026-08-14T12:00:02.000Z",
    ));
    const action = createFile("protected", "tests/feature.test.ts", "approved change\n");
    approvals.request(action, 2);
    approvals.approve(action.id);
    const context = {
      workspaceRoot: root,
      phase: "IMPLEMENT" as const,
      protectedTests: ["tests/feature.test.ts"],
      baselineVersion: 2,
      approvals,
    };
    const policy = new PolicyEngine();

    await expect(policy.evaluate(context, action)).resolves.toEqual({
      kind: "ALLOW",
      reasonCode: "ONE_TIME_APPROVAL_CONSUMED",
    });
    await expect(policy.evaluate(context, action)).resolves.toEqual({
      kind: "DENY",
      reasonCode: "APPROVAL_REPLAYED",
    });
  });

  it("denies changed arguments even when nested object keys arrive in a different order", async () => {
    const approvals = new ApprovalManager(clock("2026-08-14T12:00:00.000Z", "2026-08-14T12:00:01.000Z"));
    const original = createFile("protected", "tests/feature.test.ts", "approved change\n");
    approvals.request(original, 2);
    approvals.approve(original.id);

    expect(approvals.consume({ ...original, content: "different change\n" }, 2)).toEqual({
      ok: false,
      reasonCode: "APPROVAL_ARGUMENT_MISMATCH",
    });
  });

  it("canonicalizes object-key order and Windows path separators in approval fingerprints", () => {
    const approvals = new ApprovalManager(clock(
      "2026-08-14T12:00:00.000Z",
      "2026-08-14T12:00:01.000Z",
      "2026-08-14T12:00:02.000Z",
    ));
    const first = createFile("protected", "tests\\feature.test.ts", "approved change\n");
    const same = {
      content: "approved change\n",
      path: "tests/feature.test.ts",
      type: "create_file",
      rationale: "Implement the requested behavior",
      id: "protected",
      version: 1,
    } as Action;
    const record = approvals.request(first, 2);
    approvals.approve(first.id);

    expect(approvals.fingerprint(same, 2)).toBe(record.fingerprint);
    expect(approvals.consume(same, 2)).toEqual({ ok: true, reasonCode: "ONE_TIME_APPROVAL_CONSUMED" });
  });

  it.runIf(process.platform === "win32")("canonicalizes Windows path case in approval fingerprints", () => {
    const approvals = new ApprovalManager(clock("2026-08-14T12:00:00.000Z"));
    const requested = createFile("protected", "Tests/Feature.test.ts", "approved change\n");
    const dispatched = createFile("protected", "tests/feature.test.ts", "approved change\n");
    const record = approvals.request(requested, 2);

    expect(approvals.fingerprint(dispatched, 2)).toBe(record.fingerprint);
  });

  it("denies an approval when its baseline version is stale", () => {
    const approvals = new ApprovalManager(clock("2026-08-14T12:00:00.000Z", "2026-08-14T12:00:01.000Z"));
    const action = createFile("protected", "tests/feature.test.ts");
    approvals.request(action, 2);
    approvals.approve(action.id);

    expect(approvals.consume(action, 3)).toEqual({ ok: false, reasonCode: "APPROVAL_BASELINE_STALE" });
  });

  it("records rejection details and deterministically denies rejected approval consumption", async () => {
    const root = await repository();
    const approvals = new ApprovalManager(clock("2026-08-14T12:00:00.000Z", "2026-08-14T12:00:01.000Z"));
    const action = createFile("rejected", "tests/feature.test.ts");
    approvals.request(action, 2);

    expect(approvals.reject(action.id, "The test mutation weakens coverage.")).toMatchObject({
      rejectedAt: "2026-08-14T12:00:01.000Z",
      rejectionReason: "The test mutation weakens coverage.",
      approvedAt: null,
      consumedAt: null,
    });
    expect(approvals.consume(action, 2)).toEqual({ ok: false, reasonCode: "APPROVAL_REJECTED" });
    await expect(new PolicyEngine().evaluate({
      workspaceRoot: root,
      phase: "IMPLEMENT",
      protectedTests: ["tests/feature.test.ts"],
      baselineVersion: 2,
      approvals,
    }, action)).resolves.toEqual({ kind: "DENY", reasonCode: "APPROVAL_REJECTED" });
  });

  it("makes approval, rejection and consumption mutually exclusive", () => {
    const approved = new ApprovalManager(clock(
      "2026-08-14T12:00:00.000Z",
      "2026-08-14T12:00:01.000Z",
      "2026-08-14T12:00:02.000Z",
    ));
    const action = createFile("exclusive", "tests/feature.test.ts");
    approved.request(action, 2);
    approved.approve(action.id);
    expect(() => approved.reject(action.id, "Changed my mind.")).toThrowError();
    expect(approved.consume(action, 2)).toMatchObject({ ok: true });
    expect(() => approved.approve(action.id)).toThrowError();

    const rejected = new ApprovalManager(clock("2026-08-14T12:00:00.000Z", "2026-08-14T12:00:01.000Z"));
    rejected.request({ ...action, id: "rejected-exclusive" }, 2);
    rejected.reject("rejected-exclusive", "Unsafe action.");
    expect(() => rejected.approve("rejected-exclusive")).toThrowError();
    expect(() => rejected.reject("rejected-exclusive", "Again.")).toThrowError();
  });

  it("rejects non-increasing approval resolution timestamps", () => {
    const approvals = new ApprovalManager(clock("2026-08-14T12:00:01.000Z", "2026-08-14T12:00:00.000Z"));
    const action = createFile("time-order", "tests/feature.test.ts");
    approvals.request(action, 2);

    expect(() => approvals.approve(action.id)).toThrowError(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
  });

  it.each([
    ["PRECHECK", "create_file", "ACTION_NOT_ALLOWED_IN_PHASE"],
    ["FREEZE_TESTS", "create_file", "ACTION_NOT_ALLOWED_IN_PHASE"],
    ["VALIDATE", "run_validation", "PHASE_ACTION_ALLOWED"],
    ["IMPLEMENT", "run_validation", "PHASE_ACTION_ALLOWED"],
  ] as const)("makes phase permission for %s/%s explicit", async (phase, type, reasonCode) => {
    const root = await repository();
    const action: Action = type === "create_file"
      ? createFile("phase-action", "tests/feature.test.ts")
      : { version: 1, id: "phase-action", rationale: "Validate changes", type, validator: "all" };

    await expect(
      new PolicyEngine().evaluate({ workspaceRoot: root, phase, protectedTests: [], baselineVersion: 1 }, action),
    ).resolves.toEqual({
      kind: reasonCode === "PHASE_ACTION_ALLOWED" ? "ALLOW" : "DENY",
      reasonCode,
    });
  });

  it("enforces the complete phase/action permission matrix", async () => {
    const root = await repository();
    const actions: Record<Action["type"], Action> = {
      read_file: { version: 1, id: "read", rationale: "Read", type: "read_file", path: "src/index.ts" },
      list_files: { version: 1, id: "list", rationale: "List", type: "list_files" },
      search_files: { version: 1, id: "search", rationale: "Search", type: "search_files", query: "feature" },
      create_file: createFile("create", "tests/feature.test.ts"),
      apply_patch: { version: 1, id: "patch", rationale: "Patch", type: "apply_patch", path: "tests/feature.test.ts", patch: "patch" },
      run_validation: { version: 1, id: "validate", rationale: "Validate", type: "run_validation", validator: "all" },
      finish: { version: 1, id: "finish", rationale: "Finish", type: "finish", summary: "Done" },
      request_clarification: { version: 1, id: "clarify", rationale: "Clarify", type: "request_clarification", question: "Which behavior?" },
    };
    const allowed: Record<string, readonly Action["type"][]> = {
      PRECHECK: [],
      ANALYZE_REQUIREMENT: ["read_file", "list_files", "search_files", "request_clarification"],
      GENERATE_TESTS: ["read_file", "list_files", "search_files", "create_file", "apply_patch", "run_validation", "request_clarification"],
      CONFIRM_RED: ["run_validation"],
      FREEZE_TESTS: [],
      IMPLEMENT: ["read_file", "list_files", "search_files", "create_file", "apply_patch", "run_validation", "finish", "request_clarification"],
      VALIDATE: ["run_validation"],
      FEEDBACK: [],
      AWAITING_APPROVAL: [],
      PAUSED: [],
      SUCCEEDED: [],
      FAILED: [],
    };

    for (const [phase, allowedTypes] of Object.entries(allowed)) {
      for (const [type, action] of Object.entries(actions) as [Action["type"], Action][]) {
        const decision = await new PolicyEngine().evaluate({
          workspaceRoot: root,
          phase: phase as Parameters<PolicyEngine["evaluate"]>[0]["phase"],
          protectedTests: [],
          baselineVersion: 1,
        }, action);
        expect(decision.kind, `${phase}/${type}`).toBe(allowedTypes.includes(type) ? "ALLOW" : "DENY");
        if ((type === "list_files" || type === "search_files") && decision.kind === "ALLOW") {
          expect(decision.constraints, `${phase}/${type} constraints`).toEqual([
            { kind: "EXCLUDE_SENSITIVE_PATHS_RECURSIVELY" },
          ]);
        }
      }
    }
  });
});

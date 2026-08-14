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
    const approvals = new ApprovalManager(() => "2026-08-14T12:00:00.000Z");
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
    const approvals = new ApprovalManager(() => "2026-08-14T12:00:00.000Z");
    const original = createFile("protected", "tests/feature.test.ts", "approved change\n");
    approvals.request(original, 2);
    approvals.approve(original.id);

    expect(approvals.consume({ ...original, content: "different change\n" }, 2)).toEqual({
      ok: false,
      reasonCode: "APPROVAL_ARGUMENT_MISMATCH",
    });
  });

  it("canonicalizes object-key order and Windows path separators in approval fingerprints", () => {
    const approvals = new ApprovalManager(() => "2026-08-14T12:00:00.000Z");
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
    const approvals = new ApprovalManager(() => "2026-08-14T12:00:00.000Z");
    const requested = createFile("protected", "Tests/Feature.test.ts", "approved change\n");
    const dispatched = createFile("protected", "tests/feature.test.ts", "approved change\n");
    const record = approvals.request(requested, 2);

    expect(approvals.fingerprint(dispatched, 2)).toBe(record.fingerprint);
  });

  it("denies an approval when its baseline version is stale", () => {
    const approvals = new ApprovalManager(() => "2026-08-14T12:00:00.000Z");
    const action = createFile("protected", "tests/feature.test.ts");
    approvals.request(action, 2);
    approvals.approve(action.id);

    expect(approvals.consume(action, 3)).toEqual({ ok: false, reasonCode: "APPROVAL_BASELINE_STALE" });
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
});

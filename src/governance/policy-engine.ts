import type { Action } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import type { TaskPhase } from "../domain/task.js";
import type { ApprovalManager, ApprovalFailureReason } from "./approval.js";
import { normalizeWorkspaceRelativePath, resolveWorkspacePath } from "./path-policy.js";

export type PolicyReasonCode =
  | "PHASE_ACTION_ALLOWED"
  | "WRITE_OUTSIDE_TEST_PATTERN"
  | "ACTION_NOT_ALLOWED_IN_PHASE"
  | "SENSITIVE_PATH"
  | "PATH_ESCAPE"
  | "PROTECTED_TEST_MUTATION"
  | "ONE_TIME_APPROVAL_GRANTED"
  | "ONE_TIME_APPROVAL_CONSUMED"
  | ApprovalFailureReason;

export interface PolicyConstraint {
  kind: "EXCLUDE_SENSITIVE_PATHS_RECURSIVELY";
}

export type PolicyDecision = {
  kind: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  reasonCode: PolicyReasonCode;
  constraints?: readonly PolicyConstraint[];
};

export interface PolicyContext {
  workspaceRoot: string;
  phase: TaskPhase;
  protectedTests: readonly string[];
  baselineVersion: number;
  approvals?: ApprovalManager;
}

const phasePermissions: Readonly<Record<TaskPhase, ReadonlySet<Action["type"]>>> = {
  PRECHECK: new Set(),
  ANALYZE_REQUIREMENT: new Set(["read_file", "list_files", "search_files", "request_clarification"]),
  GENERATE_TESTS: new Set(["read_file", "list_files", "search_files", "create_file", "apply_patch", "run_validation", "request_clarification"]),
  CONFIRM_RED: new Set(["run_validation"]),
  FREEZE_TESTS: new Set(),
  IMPLEMENT: new Set(["read_file", "list_files", "search_files", "create_file", "apply_patch", "run_validation", "finish", "request_clarification"]),
  VALIDATE: new Set(["run_validation"]),
  FEEDBACK: new Set(),
  AWAITING_APPROVAL: new Set(),
  PAUSED: new Set(),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
};

export class PolicyEngine {
  async evaluate(context: PolicyContext, action: Action): Promise<PolicyDecision> {
    let actionPath: string | null = null;
    if ("path" in action && action.path !== undefined) {
      try {
        actionPath = normalizeWorkspaceRelativePath(action.path);
        await resolveWorkspacePath(context.workspaceRoot, actionPath);
      } catch (error) {
        if (error instanceof SentinelError && error.code === "PATH_ESCAPE") return deny("PATH_ESCAPE");
        if (error instanceof SentinelError && error.code === "POLICY_DENIED") return deny("SENSITIVE_PATH");
        throw error;
      }
    }

    if (isWrite(action) && context.phase === "GENERATE_TESTS" && (actionPath === null || !isTestPath(actionPath))) {
      return deny("WRITE_OUTSIDE_TEST_PATTERN");
    }
    if (!isAllowedInPhase(context.phase, action.type)) return deny("ACTION_NOT_ALLOWED_IN_PHASE");

    if (isWrite(action) && actionPath !== null && isProtected(actionPath, context.protectedTests)) {
      if (context.approvals === undefined) return requireApproval();
      const approval = context.approvals.check(action, context.baselineVersion);
      if (approval.ok) return allow(approval.reasonCode);
      if (approval.reasonCode === "APPROVAL_MISSING" || approval.reasonCode === "APPROVAL_NOT_GRANTED") {
        return requireApproval();
      }
      return deny(approval.reasonCode);
    }

    if (action.type === "list_files" || action.type === "search_files") {
      return allow("PHASE_ACTION_ALLOWED", [{ kind: "EXCLUDE_SENSITIVE_PATHS_RECURSIVELY" }]);
    }
    return allow("PHASE_ACTION_ALLOWED");
  }
}

function isAllowedInPhase(phase: TaskPhase, type: Action["type"]): boolean {
  return phasePermissions[phase].has(type);
}

function isWrite(action: Action): action is Extract<Action, { type: "create_file" | "apply_patch" }> {
  return action.type === "create_file" || action.type === "apply_patch";
}

function isTestPath(path: string): boolean {
  const lower = path.toLocaleLowerCase("en-US");
  return lower.startsWith("tests/")
    || lower.includes("/__tests__/")
    || /(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/.test(lower);
}

function isProtected(path: string, protectedTests: readonly string[]): boolean {
  const comparable = comparisonKey(path);
  return protectedTests.some((protectedPath) => comparisonKey(normalizeWorkspaceRelativePath(protectedPath)) === comparable);
}

function comparisonKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function allow(
  reasonCode: Extract<PolicyReasonCode, "PHASE_ACTION_ALLOWED" | "ONE_TIME_APPROVAL_GRANTED" | "ONE_TIME_APPROVAL_CONSUMED">,
  constraints?: readonly PolicyConstraint[],
): PolicyDecision {
  return constraints === undefined
    ? { kind: "ALLOW", reasonCode }
    : { kind: "ALLOW", reasonCode, constraints };
}

function deny(reasonCode: Exclude<PolicyReasonCode, "PHASE_ACTION_ALLOWED" | "PROTECTED_TEST_MUTATION" | "ONE_TIME_APPROVAL_CONSUMED">): PolicyDecision {
  return { kind: "DENY", reasonCode };
}

function requireApproval(): PolicyDecision {
  return { kind: "REQUIRE_APPROVAL", reasonCode: "PROTECTED_TEST_MUTATION" };
}

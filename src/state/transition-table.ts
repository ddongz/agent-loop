import { SentinelError } from "../domain/error.js";
import { TaskStateSchema, type TaskPhase, type TaskState } from "../domain/task.js";

const STATIC_TRANSITIONS: Readonly<Record<TaskPhase, readonly TaskPhase[]>> = {
  PRECHECK: ["ANALYZE_REQUIREMENT", "FAILED"],
  ANALYZE_REQUIREMENT: ["GENERATE_TESTS", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
  GENERATE_TESTS: ["CONFIRM_RED", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
  CONFIRM_RED: ["FREEZE_TESTS", "GENERATE_TESTS", "PAUSED", "FAILED"],
  FREEZE_TESTS: ["IMPLEMENT", "FAILED"],
  IMPLEMENT: ["VALIDATE", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
  VALIDATE: ["FEEDBACK", "SUCCEEDED", "AWAITING_APPROVAL", "PAUSED", "FAILED"],
  FEEDBACK: ["IMPLEMENT", "PAUSED", "FAILED"],
  AWAITING_APPROVAL: ["PAUSED", "FAILED"],
  PAUSED: ["PRECHECK"],
  SUCCEEDED: [],
  FAILED: []
};

function isAllowed(state: TaskState, to: TaskPhase): boolean {
  if (state.phase === to) return false;

  if (state.phase === "PRECHECK") {
    if (to === "FAILED") return true;
    return state.resumePhase === null
      ? to === "ANALYZE_REQUIREMENT"
      : to === state.resumePhase;
  }

  if (state.phase === "AWAITING_APPROVAL" && to === state.pendingApproval?.resumePhase) {
    return true;
  }

  if (!STATIC_TRANSITIONS[state.phase].includes(to)) return false;
  if (to === "AWAITING_APPROVAL" && (
    state.pendingApproval === null
    || state.pendingApproval.resumePhase !== state.phase
    || state.pendingApproval.baselineVersion !== state.baselineVersion
  )) return false;

  if (to === "SUCCEEDED") {
    return TaskStateSchema.safeParse({
      ...state,
      phase: to,
      resumePhase: null
    }).success;
  }

  return true;
}

export function canTransition(state: TaskState, to: TaskPhase): boolean {
  try {
    return isAllowed(state, to);
  } catch {
    return false;
  }
}

export function transition(state: TaskState, to: TaskPhase, now: string): TaskState {
  if (!isAllowed(state, to)) throw invalidTransition(state, to);
  const nextTimestamp = Date.parse(now);
  const previousTimestamp = Date.parse(state.updatedAt);
  if (!Number.isFinite(nextTimestamp) || !Number.isFinite(previousTimestamp) || nextTimestamp < previousTimestamp) {
    throw invalidTransition(state, to, "Transition timestamp is invalid or predates the current state.");
  }

  const isTerminal = to === "SUCCEEDED" || to === "FAILED";
  const consumesPrecheckResume = state.phase === "PRECHECK" && state.resumePhase !== null;
  const resumePhase = to === "AWAITING_APPROVAL" || to === "PAUSED"
    ? state.phase === "AWAITING_APPROVAL" ? state.pendingApproval?.resumePhase ?? state.resumePhase : state.phase
    : isTerminal || consumesPrecheckResume
      ? null
      : state.resumePhase;

  return TaskStateSchema.parse({
    ...state,
    phase: to,
    resumePhase,
    pendingApproval: state.phase === "AWAITING_APPROVAL" ? null : state.pendingApproval,
    updatedAt: now
  });
}

function invalidTransition(state: TaskState, to: TaskPhase, message?: string): SentinelError {
  return new SentinelError({
    code: "INVALID_TRANSITION",
    message: message ?? `Cannot transition task ${state.id} from ${state.phase} to ${to}.`,
    detail: { taskId: state.id, from: state.phase, to }
  });
}

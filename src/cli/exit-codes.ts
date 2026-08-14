import type { SentinelErrorCode } from "../domain/error.js";

export const ExitCode = {
  SUCCESS: 0,
  PAUSED: 2,
  USER_ERROR: 64,
  ENVIRONMENT_ERROR: 69,
  INTERNAL_ERROR: 70,
  INTERRUPTED: 130,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

const userErrors = new Set<SentinelErrorCode>([
  "INVALID_INPUT", "INVALID_CONFIG", "INVALID_TRANSITION", "APPROVAL_REQUIRED", "TASK_NOT_FOUND",
]);
const environmentErrors = new Set<SentinelErrorCode>([
  "DIRTY_WORKTREE", "UNSUPPORTED_NODE_VERSION", "NOT_GIT_REPOSITORY", "PACKAGE_JSON_MISSING",
  "PACKAGE_MANAGER_CONFLICT", "TEST_COMMAND_MISSING", "CREDENTIAL_BACKEND_UNAVAILABLE",
  "VALIDATION_INFRASTRUCTURE", "LLM_AUTH", "LLM_RATE_LIMIT", "LLM_TIMEOUT", "LLM_UNAVAILABLE",
]);

export function exitCodeForError(code: SentinelErrorCode): ExitCode {
  if (userErrors.has(code)) return ExitCode.USER_ERROR;
  if (environmentErrors.has(code)) return ExitCode.ENVIRONMENT_ERROR;
  return ExitCode.INTERNAL_ERROR;
}

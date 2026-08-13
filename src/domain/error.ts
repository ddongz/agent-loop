import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema)
  ])
);

export const SentinelErrorCodeSchema = z.enum([
  "INVALID_INPUT", "INVALID_CONFIG", "INVALID_TRANSITION", "DIRTY_WORKTREE", "UNSUPPORTED_NODE_VERSION", "NOT_GIT_REPOSITORY",
  "PACKAGE_JSON_MISSING", "PACKAGE_MANAGER_CONFLICT", "TEST_COMMAND_MISSING", "PATH_ESCAPE", "PROTECTED_TEST", "POLICY_DENIED",
  "APPROVAL_REQUIRED", "UNKNOWN_ACTION", "INVALID_ACTION", "PATCH_CONFLICT", "TOOL_TIMEOUT", "VALIDATION_INFRASTRUCTURE",
  "LLM_AUTH", "LLM_RATE_LIMIT", "LLM_TIMEOUT", "LLM_UNAVAILABLE", "LLM_PROTOCOL", "SCRIPT_NO_MATCH",
  "CREDENTIAL_BACKEND_UNAVAILABLE", "TASK_NOT_FOUND", "STATE_CORRUPT", "PERSISTENCE_FAILED", "INTERNAL"
]);
export type SentinelErrorCode = z.infer<typeof SentinelErrorCodeSchema>;

export const ErrorDefaults: Readonly<Record<SentinelErrorCode, Readonly<{ retryable: boolean; recoverable: boolean }>>> = {
  INVALID_INPUT: { retryable: false, recoverable: true }, INVALID_CONFIG: { retryable: false, recoverable: true }, INVALID_TRANSITION: { retryable: false, recoverable: false },
  DIRTY_WORKTREE: { retryable: false, recoverable: true }, UNSUPPORTED_NODE_VERSION: { retryable: false, recoverable: true }, NOT_GIT_REPOSITORY: { retryable: false, recoverable: true },
  PACKAGE_JSON_MISSING: { retryable: false, recoverable: true }, PACKAGE_MANAGER_CONFLICT: { retryable: false, recoverable: true }, TEST_COMMAND_MISSING: { retryable: false, recoverable: true },
  PATH_ESCAPE: { retryable: false, recoverable: false }, PROTECTED_TEST: { retryable: false, recoverable: true }, POLICY_DENIED: { retryable: false, recoverable: true }, APPROVAL_REQUIRED: { retryable: false, recoverable: true },
  UNKNOWN_ACTION: { retryable: false, recoverable: true }, INVALID_ACTION: { retryable: false, recoverable: true }, PATCH_CONFLICT: { retryable: false, recoverable: true }, TOOL_TIMEOUT: { retryable: true, recoverable: true },
  VALIDATION_INFRASTRUCTURE: { retryable: true, recoverable: true }, LLM_AUTH: { retryable: false, recoverable: true }, LLM_RATE_LIMIT: { retryable: true, recoverable: true }, LLM_TIMEOUT: { retryable: true, recoverable: true },
  LLM_UNAVAILABLE: { retryable: true, recoverable: true }, LLM_PROTOCOL: { retryable: false, recoverable: true }, SCRIPT_NO_MATCH: { retryable: false, recoverable: true },
  CREDENTIAL_BACKEND_UNAVAILABLE: { retryable: false, recoverable: true }, TASK_NOT_FOUND: { retryable: false, recoverable: true }, STATE_CORRUPT: { retryable: false, recoverable: false },
  PERSISTENCE_FAILED: { retryable: true, recoverable: false }, INTERNAL: { retryable: false, recoverable: false }
};

export const SerializedSentinelErrorSchema = z
  .object({
    code: SentinelErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    recoverable: z.boolean(),
    detail: z.record(z.string(), JsonValueSchema).nullable()
  })
  .strict();
export type SerializedSentinelError = z.infer<typeof SerializedSentinelErrorSchema>;

export interface SentinelErrorOptions {
  code: SentinelErrorCode;
  message: string;
  retryable?: boolean;
  recoverable?: boolean;
  detail?: { [key: string]: JsonValue } | null;
  cause?: unknown;
}

export class SentinelError extends Error {
  readonly code: SentinelErrorCode;
  readonly retryable: boolean;
  readonly recoverable: boolean;
  readonly detail: { [key: string]: JsonValue } | null;

  constructor(options: SentinelErrorOptions) {
    super(options.message, { cause: options.cause });
    const defaults = ErrorDefaults[options.code];
    this.name = "SentinelError";
    this.code = options.code;
    this.retryable = options.retryable ?? defaults.retryable;
    this.recoverable = options.recoverable ?? defaults.recoverable;
    this.detail = options.detail ?? null;
  }

  toJSON(redact: (value: JsonValue) => JsonValue): SerializedSentinelError {
    const redactedMessage = redact(this.message);
    const redactedDetail = this.detail === null ? null : redact(this.detail);
    return {
      code: this.code,
      message: typeof redactedMessage === "string" ? redactedMessage : String(redactedMessage),
      retryable: this.retryable,
      recoverable: this.recoverable,
      detail: isJsonObject(redactedDetail) ? redactedDetail : null
    };
  }

  static fromJSON(value: SerializedSentinelError): SentinelError {
    return new SentinelError({
      ...value,
      detail: value.detail as { [key: string]: JsonValue } | null
    });
  }
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

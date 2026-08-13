import { z } from "zod";

import { ActionSchema } from "./action.js";
import { JsonValueSchema, SerializedSentinelErrorSchema } from "./error.js";
import { FeedbackSchema, ValidationResultSchema, ValidatorNameSchema } from "./validation.js";

export const TaskPhaseSchema = z.enum([
  "PRECHECK",
  "ANALYZE_REQUIREMENT",
  "GENERATE_TESTS",
  "CONFIRM_RED",
  "FREEZE_TESTS",
  "IMPLEMENT",
  "VALIDATE",
  "FEEDBACK",
  "AWAITING_APPROVAL",
  "PAUSED",
  "SUCCEEDED",
  "FAILED"
]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const ActivePhaseSchema = z.enum([
  "PRECHECK", "ANALYZE_REQUIREMENT", "GENERATE_TESTS", "CONFIRM_RED",
  "FREEZE_TESTS", "IMPLEMENT", "VALIDATE", "FEEDBACK"
]);
export type ActivePhase = z.infer<typeof ActivePhaseSchema>;

export const BudgetSchema = z.object({
  maxIterations: z.number().int().min(1).max(32).default(8),
  maxDurationMs: z.number().int().min(1_000).default(1_800_000),
  maxTokens: z.number().int().positive().nullable(),
  maxCostUsd: z.number().finite().positive().nullable()
}).strict();
export type Budget = z.infer<typeof BudgetSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().datetime({ offset: true });
const UsageSchema = z.object({
  iterations: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().finite().nonnegative().nullable()
}).strict();
const ValidationCommandSchema = z.object({
  validator: ValidatorNameSchema, executable: z.string(), args: z.array(z.string()),
  timeoutMs: z.number().int().min(1_000), enabled: z.boolean()
}).strict();
export const ProtectedTestRefSchema = z.object({
  path: z.string(), sha256: sha256Schema, frozenAt: isoTimestampSchema
}).strict();
export type ProtectedTestRef = z.infer<typeof ProtectedTestRefSchema>;
const ValidationSnapshotSchema = z.object({
  results: z.array(ValidationResultSchema), baselineVerified: z.boolean(), workspacePolicyVerified: z.boolean(),
  codeVersion: sha256Schema, completedAt: isoTimestampSchema
}).strict();
const PendingApprovalSchema = z.object({
  action: ActionSchema, decisionReason: z.string(), requestedAt: isoTimestampSchema,
  resumePhase: ActivePhaseSchema, baselineVersion: z.number().int().nonnegative()
}).strict();

export const EventTypeSchema = z.enum([
  "TASK_CREATED", "PHASE_CHANGED", "ACTION_REQUESTED", "POLICY_DECIDED",
  "ACTION_COMPLETED", "VALIDATION_COMPLETED", "FEEDBACK_CREATED", "BASELINE_FROZEN",
  "APPROVAL_REQUESTED", "APPROVAL_RESOLVED", "TASK_PAUSED", "TASK_RESUMED",
  "TASK_SUCCEEDED", "TASK_FAILED", "USER_INTERRUPTED"
]);
export type EventType = z.infer<typeof EventTypeSchema>;
export const TaskEventSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), taskId: z.string(), sequence: z.number().int().positive(),
  type: EventTypeSchema, timestamp: isoTimestampSchema, phaseBefore: TaskPhaseSchema.nullable(),
  phaseAfter: TaskPhaseSchema.nullable(), actionId: z.string().nullable(),
  observationActionId: z.string().nullable(), causationEventId: z.string().nullable(),
  payload: z.record(z.string(), JsonValueSchema)
}).strict();
export type TaskEvent = z.infer<typeof TaskEventSchema>;

export const TestBaselineSchema = z.object({
  protectedTests: z.array(ProtectedTestRefSchema), frozenDiff: z.string(), confirmedAt: isoTimestampSchema,
  approvedVersions: z.array(z.object({ version: z.number().int().nonnegative(), approvedAt: isoTimestampSchema }).strict())
}).strict();
export type TestBaseline = z.infer<typeof TestBaselineSchema>;

export const TaskStateSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), repositoryRoot: z.string(), requirement: z.string(), phase: TaskPhaseSchema, resumePhase: ActivePhaseSchema.nullable(), iteration: z.number().int().nonnegative(), budget: BudgetSchema, usage: UsageSchema,
  validationPlan: z.array(ValidationCommandSchema), protectedTests: z.array(ProtectedTestRefSchema), baselineVersion: z.number().int().nonnegative(), pendingApproval: PendingApprovalSchema.nullable(), lastFeedback: FeedbackSchema.nullable(), lastError: SerializedSentinelErrorSchema.nullable(),
  lastCodeChangeAt: isoTimestampSchema.nullable(), finalValidationAt: isoTimestampSchema.nullable(), finalValidation: ValidationSnapshotSchema.nullable(), createdAt: isoTimestampSchema, updatedAt: isoTimestampSchema
}).strict().superRefine((state, context) => {
  if (state.phase !== "SUCCEEDED") return;
  if (state.finalValidationAt === null || state.finalValidation === null) context.addIssue({ code: "custom", message: "SUCCEEDED requires final validation." });
  if (state.finalValidationAt !== state.finalValidation?.completedAt) context.addIssue({ code: "custom", message: "Final validation timestamps must match." });
  if (state.lastCodeChangeAt !== null && state.finalValidationAt !== null && Date.parse(state.finalValidationAt) < Date.parse(state.lastCodeChangeAt)) context.addIssue({ code: "custom", message: "Final validation must follow the last code change." });
  if (state.pendingApproval !== null) context.addIssue({ code: "custom", message: "SUCCEEDED cannot await approval." });
  if (state.finalValidation !== null && (!state.finalValidation.baselineVerified || !state.finalValidation.workspacePolicyVerified)) context.addIssue({ code: "custom", message: "SUCCEEDED requires verified baseline and policy." });
  const enabled = state.validationPlan.filter(({ enabled }) => enabled).map(({ validator }) => validator);
  const results = state.finalValidation?.results ?? [];
  const resultValidators = results.map(({ validator }) => validator);
  const hasUniqueResults = new Set(resultValidators).size === resultValidators.length;
  const sameValidatorSet = enabled.length === resultValidators.length && enabled.every((validator) => resultValidators.includes(validator));
  if (!hasUniqueResults || !sameValidatorSet || results.some(({ status }) => status !== "passed")) context.addIssue({ code: "custom", message: "Final validation results must be exactly one passed result per enabled validator." });
});
export type TaskState = z.infer<typeof TaskStateSchema>;

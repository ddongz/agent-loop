import { z } from "zod";

import { ActionSchema } from "./action.js";
import { SerializedSentinelErrorSchema } from "./error.js";
import { FeedbackSchema, ValidationResultSchema, ValidatorNameSchema } from "./validation.js";

export const TaskPhaseSchema = z.enum([
  "PRECHECK", "ANALYZE_REQUIREMENT", "GENERATE_TESTS", "CONFIRM_RED", "FREEZE_TESTS", "IMPLEMENT", "VALIDATE", "FEEDBACK", "AWAITING_APPROVAL", "PAUSED", "SUCCEEDED", "FAILED"
]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const ActivePhaseSchema = z.enum(["PRECHECK", "ANALYZE_REQUIREMENT", "GENERATE_TESTS", "CONFIRM_RED", "FREEZE_TESTS", "IMPLEMENT", "VALIDATE", "FEEDBACK"]);
export type ActivePhase = z.infer<typeof ActivePhaseSchema>;

export const BudgetSchema = z.object({
  maxIterations: z.number().int().min(1).max(32).default(8),
  maxDurationMs: z.number().int().min(1_000).default(1_800_000),
  maxTokens: z.number().int().positive().nullable(),
  maxCostUsd: z.number().finite().positive().nullable()
}).strict();
export type Budget = z.infer<typeof BudgetSchema>;

const UsageSchema = z.object({
  iterations: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), costUsd: z.number().finite().nonnegative().nullable()
}).strict();
const ValidationCommandSchema = z.object({ validator: ValidatorNameSchema, executable: z.string(), args: z.array(z.string()), timeoutMs: z.number().int().min(1_000), enabled: z.boolean() }).strict();
const ProtectedTestRefSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), frozenAt: z.string().datetime({ offset: true }) }).strict();
const ValidationSnapshotSchema = z.object({ results: z.array(ValidationResultSchema), baselineVerified: z.boolean(), workspacePolicyVerified: z.boolean(), codeVersion: z.string().regex(/^[0-9a-f]{64}$/), completedAt: z.string().datetime({ offset: true }) }).strict();
const PendingApprovalSchema = z.object({ action: ActionSchema, decisionReason: z.string(), requestedAt: z.string().datetime({ offset: true }), resumePhase: ActivePhaseSchema, baselineVersion: z.number().int().nonnegative() }).strict();

export const TaskStateSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), repositoryRoot: z.string(), requirement: z.string(), phase: TaskPhaseSchema, resumePhase: ActivePhaseSchema.nullable(), iteration: z.number().int().nonnegative(), budget: BudgetSchema, usage: UsageSchema,
  validationPlan: z.array(ValidationCommandSchema), protectedTests: z.array(ProtectedTestRefSchema), baselineVersion: z.number().int().nonnegative(), pendingApproval: PendingApprovalSchema.nullable(), lastFeedback: FeedbackSchema.nullable(), lastError: SerializedSentinelErrorSchema.nullable(),
  lastCodeChangeAt: z.string().datetime({ offset: true }).nullable(), finalValidationAt: z.string().datetime({ offset: true }).nullable(), finalValidation: ValidationSnapshotSchema.nullable(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true })
}).strict().superRefine((state, context) => {
  if (state.phase !== "SUCCEEDED") return;
  if (state.finalValidationAt === null || state.finalValidation === null) context.addIssue({ code: "custom", message: "SUCCEEDED requires final validation." });
  if (state.finalValidationAt !== state.finalValidation?.completedAt) context.addIssue({ code: "custom", message: "Final validation timestamps must match." });
  if (state.lastCodeChangeAt !== null && state.finalValidationAt !== null && state.finalValidationAt < state.lastCodeChangeAt) context.addIssue({ code: "custom", message: "Final validation must follow the last code change." });
  if (state.pendingApproval !== null) context.addIssue({ code: "custom", message: "SUCCEEDED cannot await approval." });
  if (state.finalValidation !== null && (!state.finalValidation.baselineVerified || !state.finalValidation.workspacePolicyVerified)) context.addIssue({ code: "custom", message: "SUCCEEDED requires verified baseline and policy." });
  for (const command of state.validationPlan.filter(({ enabled }) => enabled)) {
    const results = state.finalValidation?.results.filter(({ validator }) => validator === command.validator && state.finalValidation !== null && state.finalValidation.results.filter(({ validator: resultValidator }) => resultValidator === command.validator).length === 1) ?? [];
    if (results.length !== 1 || results[0]?.status !== "passed") context.addIssue({ code: "custom", message: `Enabled validator ${command.validator} must have exactly one passed final result.` });
  }
});
export type TaskState = z.infer<typeof TaskStateSchema>;

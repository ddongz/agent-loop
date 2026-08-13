import { z } from "zod";

export const ValidatorNameSchema = z.enum(["test", "typecheck", "lint", "build"]);
export type ValidatorName = z.infer<typeof ValidatorNameSchema>;

export const ValidationStatusSchema = z.enum(["passed", "failed", "infrastructure_error"]);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

export const IssueSeveritySchema = z.enum(["error", "warning"]);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const ValidationIssueCategorySchema = z.enum([
  "TEST_ASSERTION",
  "TEST_RUNTIME",
  "TEST_DISCOVERY",
  "SYNTAX_ERROR",
  "TYPE_ERROR",
  "LINT_ERROR",
  "BUILD_ERROR",
  "DEPENDENCY_ERROR",
  "TIMEOUT",
  "INFRASTRUCTURE_ERROR",
  "UNKNOWN"
]);
export type ValidationIssueCategory = z.infer<typeof ValidationIssueCategorySchema>;

export const ValidationIssueSchema = z
  .object({
    category: ValidationIssueCategorySchema,
    severity: IssueSeveritySchema,
    message: z.string(),
    file: z.string().nullable(),
    line: z.number().int().nonnegative().nullable(),
    column: z.number().int().nonnegative().nullable(),
    rule: z.string().nullable(),
    testName: z.string().nullable(),
    fingerprint: z.string()
  })
  .strict();
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationResultSchema = z
  .object({
    validator: ValidatorNameSchema,
    status: ValidationStatusSchema,
    exitCode: z.number().int().nullable(),
    command: z.object({ executable: z.string(), args: z.array(z.string()) }).strict(),
    startedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().nonnegative(),
    issues: z.array(ValidationIssueSchema),
    stdoutSummary: z.string(),
    stderrSummary: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean()
  })
  .strict();
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

export const ProgressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("improved"), resolved: z.array(z.string()), introduced: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("unchanged"), repeated: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("regressed"), introduced: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("oscillating"), cycleLength: z.union([z.literal(2), z.literal(3)]) }).strict()
]);
export type Progress = z.infer<typeof ProgressSchema>;

export const FeedbackSchema = z
  .object({
    decision: z.enum(["CONTINUE", "PAUSE_NO_PROGRESS", "PAUSE_BUDGET", "REQUEST_SUCCESS_CHECK", "FAIL_INFRASTRUCTURE"]),
    summary: z.string(),
    currentStage: ValidatorNameSchema.nullable(),
    progress: ProgressSchema.nullable(),
    issues: z.array(ValidationIssueSchema),
    remainingIterations: z.number().int().nonnegative(),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();
export type Feedback = z.infer<typeof FeedbackSchema>;

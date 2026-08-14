import { z } from "zod";

import { ActionSchema } from "../domain/action.js";
import { JsonValueSchema } from "../domain/error.js";
import { BudgetSchema, TaskPhaseSchema } from "../domain/task.js";
import { ProgressSchema, ValidatorNameSchema } from "../domain/validation.js";

const encodedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const CompletionToolSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  description: z.string().min(1).max(2_000),
  inputSchema: JsonObjectSchema
}).strict();
export type CompletionTool = z.infer<typeof CompletionToolSchema>;

export const ContextEventSchema = z.object({
  sequence: z.number().int().positive(),
  type: z.string().min(1).max(64),
  timestamp: z.string().datetime({ offset: true }),
  phaseBefore: TaskPhaseSchema.nullable(),
  phaseAfter: TaskPhaseSchema.nullable(),
  actionId: z.string().nullable(),
  observationActionId: z.string().nullable(),
  payload: JsonObjectSchema
}).strict();

export const ContextObservationSchema = z.object({
  actionId: z.string().max(64),
  tool: z.string().max(128),
  status: z.enum(["succeeded", "failed", "denied", "approval_required"]),
  output: z.string().max(65_536),
  truncated: z.boolean(),
  errorCode: z.string().max(64).nullable().optional()
}).strict();

export const CompactFeedbackSchema = z.object({
  decision: z.enum(["CONTINUE", "PAUSE_NO_PROGRESS", "PAUSE_BUDGET", "REQUEST_SUCCESS_CHECK", "FAIL_INFRASTRUCTURE"]),
  summary: z.string().max(8_192),
  currentStage: ValidatorNameSchema.nullable(),
  progress: ProgressSchema.nullable(),
  issueFingerprints: z.array(z.string().max(256)).max(64),
  remainingIterations: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true })
}).strict();

const CurrentContextSchema = z.object({
  iteration: z.number().int().nonnegative(),
  budget: BudgetSchema,
  usage: z.object({
    iterations: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costUsd: z.number().finite().nonnegative().nullable()
  }).strict()
}).strict();

export const CompletionRequestSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1).max(256),
  phase: TaskPhaseSchema,
  context: z.object({
    systemGovernance: z.string().min(1).max(16_384),
    requirement: z.string().min(1).max(16_384),
    current: CurrentContextSchema,
    repositorySummary: z.string().max(16_384),
    feedback: CompactFeedbackSchema.nullable(),
    events: z.array(ContextEventSchema).max(12),
    observations: z.array(ContextObservationSchema).max(8)
  }).strict(),
  tools: z.array(CompletionToolSchema).min(1).max(32)
}).strict().superRefine((request, context) => {
  if (encodedBytes(request.tools) > 32_768) {
    context.addIssue({ code: "custom", path: ["tools"], message: "Tool schemas exceed the 32 KiB encoded limit." });
  }
  if (encodedBytes(request) > 98_304) {
    context.addIssue({ code: "custom", message: "Completion request exceeds the 96 KiB encoded limit." });
  }
});
export type CompletionRequest = z.infer<typeof CompletionRequestSchema>;

export const CompletionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable()
}).strict();
export type CompletionUsage = z.infer<typeof CompletionUsageSchema>;

export const CompletionResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("action"),
    action: ActionSchema,
    providerRequestId: z.string().max(256).nullable(),
    usage: CompletionUsageSchema.nullable()
  }).strict(),
  z.object({
    outcome: z.literal("no_action"),
    action: z.null(),
    reason: z.enum(["scripted_no_action"]),
    providerRequestId: z.string().max(256).nullable(),
    usage: CompletionUsageSchema.nullable()
  }).strict()
]);
export type CompletionResult = z.infer<typeof CompletionResultSchema>;

export interface LLMClient {
  complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
}

export type FetchTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

import { z } from "zod";

import { SentinelErrorCodeSchema, SerializedSentinelErrorSchema } from "./error.js";
import { ValidatorNameSchema } from "./validation.js";

const MiB = 1_048_576;
const ActionBaseSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(64),
  rationale: z.string().min(1).max(2_000)
});
const pathSchema = z.string().min(1).max(4_096);

export const ActionSchema = z.discriminatedUnion("type", [
  ActionBaseSchema.extend({ type: z.literal("read_file"), path: pathSchema, maxBytes: z.number().int().min(1).max(MiB).default(65_536) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("list_files"), path: pathSchema.optional(), maxDepth: z.number().int().min(0).max(20).default(5), maxEntries: z.number().int().min(1).max(1_000).default(200) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("search_files"), query: z.string().min(1).max(1_000), path: pathSchema.optional(), glob: z.string().min(1).max(500).optional(), maxResults: z.number().int().min(1).max(1_000).default(200) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("create_file"), path: pathSchema, content: z.string().max(MiB) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("apply_patch"), path: pathSchema, patch: z.string().max(MiB) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("run_validation"), validator: z.union([ValidatorNameSchema, z.literal("all")]) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("finish"), summary: z.string().min(1).max(2_000) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("request_clarification"), question: z.string().min(1).max(2_000) }).strict()
]);
export type Action = z.infer<typeof ActionSchema>;

export const ObservationSchema = z.object({
  actionId: z.string(),
  tool: z.enum(["read_file", "list_files", "search_files", "create_file", "apply_patch", "run_validation", "finish", "request_clarification"]),
  status: z.enum(["succeeded", "failed", "denied", "approval_required"]),
  startedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().nonnegative(),
  output: z.string(),
  truncated: z.boolean(),
  error: SerializedSentinelErrorSchema.nullable()
}).strict();
export type Observation = z.infer<typeof ObservationSchema>;

export { SentinelErrorCodeSchema };

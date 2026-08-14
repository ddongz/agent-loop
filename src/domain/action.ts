import { z } from "zod";

import { SentinelErrorCodeSchema, SerializedSentinelErrorSchema } from "./error.js";
import { ValidatorNameSchema } from "./validation.js";

const MiB = 1_048_576;
const ActionBaseSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(64),
  rationale: z.string().min(1).max(2_000)
}).strict();
const pathSchema = z.string().min(1).max(4_096);
const patchSchema = z.string().max(MiB);

const ApplyPatchSchema = ActionBaseSchema.extend({
  type: z.literal("apply_patch"),
  path: pathSchema,
  patch: patchSchema
})
  .strict()
  .superRefine(({ path, patch }, context) => {
    if (!isNormalizablePatch(patch, path)) {
      context.addIssue({
        code: "custom",
        message: "Patch must be one matching unified diff, a bare hunk set, or a single-file Begin Patch block.",
      });
    }
  });

export const ActionSchema = z.discriminatedUnion("type", [
  ActionBaseSchema.extend({ type: z.literal("read_file"), path: pathSchema, maxBytes: z.number().int().min(1).max(MiB).default(65_536) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("list_files"), path: pathSchema.optional(), maxDepth: z.number().int().min(0).max(20).default(5), maxEntries: z.number().int().min(1).max(1_000).default(200) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("search_files"), query: z.string().min(1).max(1_000), path: pathSchema.optional(), glob: z.string().min(1).max(500).optional(), maxResults: z.number().int().min(1).max(1_000).default(200) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("create_file"), path: pathSchema, content: z.string().max(MiB) }).strict(),
  ApplyPatchSchema,
  ActionBaseSchema.extend({ type: z.literal("run_validation"), validator: z.union([ValidatorNameSchema, z.literal("all")]) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("finish"), summary: z.string().min(1).max(2_000) }).strict(),
  ActionBaseSchema.extend({ type: z.literal("request_clarification"), question: z.string().min(1).max(2_000) }).strict()
]);
export type Action = z.infer<typeof ActionSchema>;

export const ObservationSchema = z.object({
  actionId: z.string(),
  tool: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/),
  status: z.enum(["succeeded", "failed", "denied", "approval_required"]),
  startedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().nonnegative(),
  output: z.string(),
  truncated: z.boolean(),
  error: SerializedSentinelErrorSchema.nullable()
}).strict();
export type Observation = z.infer<typeof ObservationSchema>;

// Models emit several patch dialects (classic unified diffs, bare hunks
// without file headers, and Claude-style *** Begin Patch blocks). The schema
// accepts any single-file form that the file tool can normalize to a unified
// diff; mismatched classic headers and multi-file patches stay rejected.
function isNormalizablePatch(patch: string, path: string): boolean {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines[0] === "*** Begin Patch") {
    const directives = lines.filter((line) => /^\*\*\* (?:Update|Add|Delete) File: .+$/.test(line.trim()));
    if (directives.length !== 1 || lines.at(-1) !== "*** End Patch") return false;
    const target = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(directives[0]!)?.[1];
    return target === path;
  }
  const headers = lines.filter((line) => line.startsWith("--- ") || line.startsWith("+++ "));
  if (headers.length === 0) {
    return lines.some((line) => line === "@@" || /^@@\s/.test(line))
      && lines.every((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
  }
  return headers.length === 2
    && headers[0] === `--- a/${path}`
    && headers[1] === `+++ b/${path}`
    && lines.slice(2).every((line) => !line.startsWith("--- ") && !line.startsWith("+++ "));
}

export { SentinelErrorCodeSchema };

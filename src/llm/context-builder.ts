import type { Observation } from "../domain/action.js";
import { SentinelError, type JsonValue } from "../domain/error.js";
import type { TaskEvent, TaskState } from "../domain/task.js";
import type { Feedback, Progress } from "../domain/validation.js";
import { sanitizeText } from "../feedback/fingerprint.js";
import {
  CompletionRequestSchema,
  type CompletionRequest,
  type CompletionTool,
  type ContextEventSchema,
  type ContextObservationSchema
} from "./types.js";
import type { z } from "zod";

export const CONTEXT_SECTION_LIMITS = Object.freeze({
  systemBytes: 8_192,
  requirementBytes: 8_192,
  repositoryBytes: 8_192,
  feedbackSummaryBytes: 4_096,
  eventPayloadBytes: 2_048,
  observationOutputBytes: 4_096,
  maxEvents: 12,
  maxObservations: 8
});

type ContextEvent = z.infer<typeof ContextEventSchema>;
type ContextObservation = z.infer<typeof ContextObservationSchema>;

export interface BuildContextOptions {
  systemGovernance: string;
  repositorySummary: string;
  tools: readonly CompletionTool[];
  observations?: readonly Observation[] | readonly ContextObservation[];
}

const relevantEventTypes = new Set<TaskEvent["type"]>([
  "PHASE_CHANGED",
  "ACTION_REQUESTED",
  "POLICY_DECIDED",
  "ACTION_COMPLETED",
  "VALIDATION_COMPLETED",
  "FEEDBACK_CREATED",
  "BASELINE_FROZEN",
  "APPROVAL_REQUESTED",
  "APPROVAL_RESOLVED",
  "TASK_PAUSED",
  "TASK_RESUMED",
  "USER_INTERRUPTED"
]);

export function buildContext(
  task: TaskState,
  events: readonly TaskEvent[],
  feedback: Feedback | null,
  options: BuildContextOptions
): CompletionRequest {
  const request = {
    schemaVersion: 1 as const,
    taskId: task.id,
    phase: task.phase,
    context: {
      systemGovernance: boundedText(options.systemGovernance, CONTEXT_SECTION_LIMITS.systemBytes),
      requirement: boundedText(task.requirement, CONTEXT_SECTION_LIMITS.requirementBytes),
      current: {
        iteration: task.iteration,
        budget: task.budget,
        usage: task.usage
      },
      repositorySummary: boundedText(options.repositorySummary, CONTEXT_SECTION_LIMITS.repositoryBytes),
      feedback: compactFeedback(feedback),
      events: selectEvents(task.id, events),
      observations: selectObservations(options.observations ?? [])
    },
    tools: options.tools.map((tool) => ({
      name: tool.name,
      description: boundedText(tool.description, 2_000),
      inputSchema: redactObject(tool.inputSchema)
    }))
  };

  const parsed = CompletionRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SentinelError({
      code: "INVALID_INPUT",
      message: "Unable to construct a bounded LLM completion request.",
      detail: { issueCount: parsed.error.issues.length },
      cause: parsed.error
    });
  }
  return parsed.data;
}

function compactFeedback(feedback: Feedback | null): CompletionRequest["context"]["feedback"] {
  if (feedback === null) return null;
  return {
    decision: feedback.decision,
    summary: boundedText(feedback.summary, CONTEXT_SECTION_LIMITS.feedbackSummaryBytes),
    currentStage: feedback.currentStage,
    progress: compactProgress(feedback.progress),
    issueFingerprints: [...new Set(feedback.issues.map(({ fingerprint }) => boundedText(fingerprint, 256)))].slice(0, 64),
    remainingIterations: feedback.remainingIterations,
    createdAt: feedback.createdAt
  };
}

function compactProgress(progress: Progress | null): Progress | null {
  if (progress === null || progress.kind === "oscillating") return progress;
  if (progress.kind === "unchanged") return { kind: "unchanged", repeated: progress.repeated.slice(0, 64).map((item) => boundedText(item, 256)) };
  if (progress.kind === "regressed") return { kind: "regressed", introduced: progress.introduced.slice(0, 64).map((item) => boundedText(item, 256)) };
  return {
    kind: "improved",
    resolved: progress.resolved.slice(0, 64).map((item) => boundedText(item, 256)),
    introduced: progress.introduced.slice(0, 64).map((item) => boundedText(item, 256))
  };
}

function selectEvents(taskId: string, events: readonly TaskEvent[]): ContextEvent[] {
  return events
    .filter((event) => event.taskId === taskId && relevantEventTypes.has(event.type))
    .toSorted((left, right) => left.sequence - right.sequence)
    .slice(-CONTEXT_SECTION_LIMITS.maxEvents)
    .map((event) => ({
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      phaseBefore: event.phaseBefore,
      phaseAfter: event.phaseAfter,
      actionId: event.actionId,
      observationActionId: event.observationActionId,
      payload: compactObject(event.payload, CONTEXT_SECTION_LIMITS.eventPayloadBytes)
    }));
}

function selectObservations(observations: readonly Observation[] | readonly ContextObservation[]): ContextObservation[] {
  return observations.slice(-CONTEXT_SECTION_LIMITS.maxObservations).map((observation) => ({
    actionId: boundedText(observation.actionId, 64),
    tool: boundedText(observation.tool, 128),
    status: observation.status,
    output: boundedText(observation.output, CONTEXT_SECTION_LIMITS.observationOutputBytes),
    truncated: observation.truncated,
    errorCode: "error" in observation ? observation.error?.code ?? null : observation.errorCode ?? null
  }));
}

function compactObject(value: Record<string, JsonValue>, maxBytes: number): Record<string, JsonValue> {
  const redacted = redactObject(value);
  if (encodedBytes(redacted) <= maxBytes) return redacted;
  return { compact: boundedText(JSON.stringify(redacted), maxBytes - 32) };
}

function redactObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  const redacted = redactJson(value);
  return redacted !== null && typeof redacted === "object" && !Array.isArray(redacted) ? redacted : {};
}

function redactJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return sanitizeText(value);
  if (Array.isArray(value)) return value.slice(0, 128).map(redactJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 128).map(([key, item]) => [sanitizeText(key), redactJson(item)]));
  }
  return value;
}

function boundedText(value: string, maxBytes: number): string {
  const sanitized = sanitizeText(value);
  if (encodedBytes(sanitized) <= maxBytes) return sanitized;
  const suffix = "…[truncated]";
  const suffixBytes = encodedBytes(suffix);
  let remaining = Math.max(0, maxBytes - suffixBytes);
  let output = "";
  for (const character of sanitized) {
    const size = encodedBytes(character);
    if (size > remaining) break;
    output += character;
    remaining -= size;
  }
  return output + suffix;
}

function encodedBytes(value: string | Record<string, JsonValue>): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return new TextEncoder().encode(serialized).byteLength;
}

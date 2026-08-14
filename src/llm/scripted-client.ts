import { z } from "zod";

import { ActionSchema, type Action } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import { TaskPhaseSchema } from "../domain/task.js";
import { CompletionRequestSchema, CompletionResultSchema, type CompletionRequest, type CompletionResult, type LLMClient } from "./types.js";

const ObservationPredicateSchema = z.object({
  tool: z.string().min(1).max(128).optional(),
  status: z.enum(["succeeded", "failed", "denied", "approval_required"]).optional(),
  outputIncludes: z.string().min(1).max(2_000).optional()
}).strict().refine((value) => Object.keys(value).length > 0, "An observation predicate cannot be empty.");

const ScriptPredicateSchema = z.object({
  phase: TaskPhaseSchema.optional(),
  feedbackFingerprint: z.string().min(1).max(256).optional(),
  observation: ObservationPredicateSchema.optional(),
  call: z.number().int().positive().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "A script predicate cannot be empty.");

export type ScriptPredicate = z.infer<typeof ScriptPredicateSchema>;

export interface ScriptedActionStep {
  when: ScriptPredicate;
  action: Action;
}

export interface ScriptedNoActionStep {
  when: ScriptPredicate;
  noAction: true;
}

export type ScriptedStep = ScriptedActionStep | ScriptedNoActionStep;

interface ValidatedStep {
  when: ScriptPredicate;
  result: CompletionResult;
}

export class ScriptedLLMClient implements LLMClient {
  readonly #steps: readonly ValidatedStep[];
  #callCount = 0;

  constructor(steps: readonly ScriptedStep[]) {
    try {
      this.#steps = steps.map((step) => {
        const when = ScriptPredicateSchema.parse(step.when);
        const result: CompletionResult = "action" in step
          ? {
              outcome: "action",
              action: ActionSchema.parse(step.action),
              providerRequestId: null,
              usage: null
            }
          : {
              outcome: "no_action",
              action: null,
              reason: "scripted_no_action",
              providerRequestId: null,
              usage: null
            };
        return { when, result: CompletionResultSchema.parse(result) };
      });
    } catch (cause) {
      throw new SentinelError({
        code: "LLM_PROTOCOL",
        message: "Scripted LLM configuration contains an invalid predicate or action.",
        cause
      });
    }
  }

  async complete(request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    if (signal?.aborted) {
      throw new SentinelError({
        code: "LLM_TIMEOUT",
        message: "Scripted LLM request was aborted by the caller.",
        retryable: false
      });
    }

    const parsedRequest = CompletionRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new SentinelError({
        code: "LLM_PROTOCOL",
        message: "Scripted LLM request violates the bounded request contract.",
        cause: parsedRequest.error
      });
    }

    this.#callCount += 1;
    const matches = this.#steps.filter(({ when }) => matchesPredicate(when, parsedRequest.data, this.#callCount));
    if (matches.length !== 1) {
      const qualifier = matches.length === 0 ? "no matching scripted response" : "ambiguous scripted responses";
      throw new SentinelError({
        code: "SCRIPT_NO_MATCH",
        message: `Scripted LLM has ${qualifier} for call ${this.#callCount}.`,
        detail: { call: this.#callCount, matchCount: matches.length, phase: parsedRequest.data.phase }
      });
    }
    return matches[0]!.result;
  }
}

function matchesPredicate(predicate: ScriptPredicate, request: CompletionRequest, call: number): boolean {
  if (predicate.phase !== undefined && predicate.phase !== request.phase) return false;
  if (predicate.call !== undefined && predicate.call !== call) return false;
  if (predicate.feedbackFingerprint !== undefined && !feedbackFingerprints(request).has(predicate.feedbackFingerprint)) return false;
  if (predicate.observation !== undefined && !request.context.observations.some((item) => {
    if (predicate.observation?.tool !== undefined && item.tool !== predicate.observation.tool) return false;
    if (predicate.observation?.status !== undefined && item.status !== predicate.observation.status) return false;
    if (predicate.observation?.outputIncludes !== undefined && !item.output.includes(predicate.observation.outputIncludes)) return false;
    return true;
  })) return false;
  return true;
}

function feedbackFingerprints(request: CompletionRequest): Set<string> {
  const feedback = request.context.feedback;
  if (feedback === null) return new Set();
  const fingerprints = [...feedback.issueFingerprints];
  if (feedback.progress?.kind === "improved") fingerprints.push(...feedback.progress.resolved, ...feedback.progress.introduced);
  if (feedback.progress?.kind === "regressed") fingerprints.push(...feedback.progress.introduced);
  if (feedback.progress?.kind === "unchanged") fingerprints.push(...feedback.progress.repeated);
  return new Set(fingerprints);
}

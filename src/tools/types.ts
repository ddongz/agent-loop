import type { Action, Observation } from "../domain/action.js";
import type { z } from "zod";
import type { JsonValue, SentinelErrorCode } from "../domain/error.js";
import { SentinelError } from "../domain/error.js";
import type { PolicyConstraint } from "../governance/policy-engine.js";

export interface Tool<I extends Action = Action> {
  readonly type: Action["type"];
  readonly schema: z.ZodType<I>;
  readonly constraints: readonly PolicyConstraint["kind"][];
  execute(action: Action, signal: AbortSignal): Promise<Observation>;
}

export type Redactor = (value: JsonValue) => JsonValue;

interface ObservationSubject {
  id: string;
  type: string;
}

export class ObservationTimer {
  readonly #action: ObservationSubject;
  readonly #startedAt = new Date();
  readonly #started = performance.now();
  readonly #redact: Redactor;

  constructor(action: ObservationSubject, redact: Redactor = identityRedactor) {
    this.#action = action;
    this.#redact = redact;
  }

  succeed(output: string, truncated = false): Observation {
    return this.#finish("succeeded", output, truncated, null);
  }

  fail(error: unknown, output = "", truncated = false): Observation {
    return this.#finish("failed", output, truncated, normalizeError(error).toJSON(this.#redact));
  }

  #finish(
    status: Observation["status"],
    output: string,
    truncated: boolean,
    error: Observation["error"],
  ): Observation {
    const redactedOutput = this.#redact(output);
    return {
      actionId: this.#action.id,
      tool: this.#action.type,
      status,
      startedAt: this.#startedAt.toISOString(),
      durationMs: Math.max(0, performance.now() - this.#started),
      output: typeof redactedOutput === "string" ? redactedOutput : String(redactedOutput),
      truncated,
      error,
    };
  }
}

export function normalizeError(error: unknown, fallbackCode: SentinelErrorCode = "INTERNAL"): SentinelError {
  if (error instanceof SentinelError) return error;
  const message = error instanceof Error ? error.message : "An unknown tool error occurred.";
  return new SentinelError({ code: fallbackCode, message, cause: error });
}

export function identityRedactor(value: JsonValue): JsonValue {
  return value;
}

export function decodeUtf8Prefix(content: Buffer, mayEndMidCharacter: boolean): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maximumTrim = mayEndMidCharacter ? Math.min(3, content.byteLength) : 0;
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    try {
      return decoder.decode(content.subarray(0, content.byteLength - trim));
    } catch {
      // Only an incomplete final UTF-8 sequence may be removed from bounded output.
    }
  }
  throw new SentinelError({ code: "INVALID_INPUT", message: "Bounded content is not valid UTF-8 text." });
}

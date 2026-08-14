import { ActionSchema, ObservationSchema, type Action, type Observation } from "../domain/action.js";
import { SentinelError, type JsonValue } from "../domain/error.js";
import type { PolicyContext, PolicyDecision, PolicyEngine } from "../governance/policy-engine.js";
import { ObservationTimer, identityRedactor, type Redactor, type Tool } from "./types.js";

export interface DispatchContext extends PolicyContext {
  signal?: AbortSignal;
}

const actionTypes = new Set<Action["type"]>([
  "read_file", "list_files", "search_files", "create_file", "apply_patch", "run_validation", "finish", "request_clarification",
]);

export class ToolRegistry {
  readonly #policy: Pick<PolicyEngine, "evaluate">;
  readonly #tools: ReadonlyMap<Action["type"], Tool>;
  readonly #redact: Redactor;

  constructor(policy: Pick<PolicyEngine, "evaluate">, tools: readonly Tool[], redact: Redactor = identityRedactor) {
    const registry = new Map<Action["type"], Tool>();
    for (const tool of tools) {
      if (registry.has(tool.type)) {
        throw new SentinelError({ code: "INVALID_INPUT", message: `Tool type is registered more than once: ${tool.type}` });
      }
      registry.set(tool.type, tool);
    }
    this.#policy = policy;
    this.#tools = registry;
    this.#redact = redact;
  }

  async dispatch(context: DispatchContext, rawAction: unknown): Promise<Observation> {
    const parsed = ActionSchema.safeParse(rawAction);
    if (!parsed.success) return this.#protocolFailure(rawAction, parsed.error.message);
    const action = parsed.data;
    const timer = new ObservationTimer(action, this.#redact);

    let decision: PolicyDecision;
    try {
      decision = await this.#policy.evaluate(context, action);
    } catch (error) {
      return timer.fail(error);
    }
    if (decision.kind === "DENY") {
      return policyObservation(timer, "denied", "POLICY_DENIED", decision.reasonCode);
    }
    if (decision.kind === "REQUIRE_APPROVAL") {
      return policyObservation(timer, "approval_required", "APPROVAL_REQUIRED", decision.reasonCode);
    }

    const tool = this.#tools.get(action.type);
    if (tool === undefined) {
      return timer.fail(new SentinelError({ code: "UNKNOWN_ACTION", message: `No tool is registered for ${action.type}.` }));
    }
    const unsupported = (decision.constraints ?? []).find(({ kind }) => !tool.constraints.includes(kind));
    if (unsupported !== undefined) {
      return policyObservation(timer, "denied", "POLICY_DENIED", unsupported.kind);
    }
    const toolInput = tool.schema.safeParse(action);
    if (!toolInput.success) {
      return timer.fail(new SentinelError({
        code: "INVALID_ACTION",
        message: "The action does not satisfy the selected tool schema.",
        detail: { reason: toolInput.error.message },
      }));
    }
    if (decision.reasonCode === "ONE_TIME_APPROVAL_GRANTED") {
      if (context.approvals === undefined) {
        return timer.fail(new SentinelError({ code: "INTERNAL", message: "Policy granted an approval without an approval manager." }));
      }
      let consumption;
      try {
        consumption = context.approvals.consume(action, context.baselineVersion);
      } catch (error) {
        return timer.fail(error);
      }
      if (!consumption.ok) {
        return policyObservation(timer, "denied", "POLICY_DENIED", consumption.reasonCode);
      }
    }

    try {
      const observation = await tool.execute(toolInput.data, context.signal ?? new AbortController().signal);
      const normalized = ObservationSchema.safeParse(observation);
      if (!normalized.success || normalized.data.actionId !== action.id || normalized.data.tool !== action.type) {
        return timer.fail(new SentinelError({ code: "INTERNAL", message: "Tool returned an invalid observation." }));
      }
      return redactObservation(normalized.data, this.#redact);
    } catch (error) {
      return timer.fail(error);
    }
  }

  #protocolFailure(rawAction: unknown, reason: string): Observation {
    const candidate = protocolSubject(rawAction);
    const timer = new ObservationTimer(candidate, this.#redact);
    const rawType = typeof rawAction === "object" && rawAction !== null && "type" in rawAction
      ? (rawAction as { type?: unknown }).type
      : undefined;
    const code = typeof rawType === "string" && actionTypes.has(rawType as Action["type"])
      ? "INVALID_ACTION"
      : "UNKNOWN_ACTION";
    return timer.fail(new SentinelError({ code, message: "The requested action is not valid.", detail: { reason } }));
  }
}

function redactObservation(observation: Observation, redact: Redactor): Observation {
  const output = redact(observation.output);
  if (observation.error === null) {
    return { ...observation, output: typeof output === "string" ? output : String(output) };
  }
  const message = redact(observation.error.message);
  const detail = observation.error.detail === null ? null : redact(observation.error.detail);
  return {
    ...observation,
    output: typeof output === "string" ? output : String(output),
    error: {
      ...observation.error,
      message: typeof message === "string" ? message : String(message),
      detail: isJsonObject(detail) ? detail : null,
    },
  };
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function policyObservation(
  timer: ObservationTimer,
  status: Extract<Observation["status"], "denied" | "approval_required">,
  code: "POLICY_DENIED" | "APPROVAL_REQUIRED",
  reasonCode: string,
): Observation {
  const failed = timer.fail(new SentinelError({ code, message: "Policy did not permit tool execution.", detail: { reasonCode } }));
  return { ...failed, status };
}

function protocolSubject(raw: unknown): { id: string; type: string } {
  const record = typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
  const type = typeof record.type === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(record.type)
    ? record.type
    : "unknown";
  const id = typeof record.id === "string" && record.id.length > 0 && record.id.length <= 64 ? record.id : "invalid-action";
  return { id, type };
}

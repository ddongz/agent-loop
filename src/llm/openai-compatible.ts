import { z } from "zod";

import { ActionSchema, type Action } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import {
  CompletionRequestSchema,
  CompletionResultSchema,
  type CompletionRequest,
  type CompletionResult,
  type FetchTransport,
  type LLMClient
} from "./types.js";

const MAX_RESPONSE_BYTES = 1_048_576;
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const reservedHeaders = new Set([
  "authorization",
  "content-type",
  "content-length",
  "host",
  "connection",
  "transfer-encoding",
  "proxy-authorization"
]);

const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }).passthrough()
}).passthrough();
const ChoiceSchema = z.object({
  index: z.number().int(),
  finish_reason: z.string().nullable(),
  message: z.object({
    role: z.literal("assistant"),
    content: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional()
  }).passthrough()
}).passthrough();
const ResponseSchema = z.object({
  id: z.string().max(256).optional(),
  choices: z.array(ChoiceSchema),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().nullable().optional(),
    completion_tokens: z.number().int().nonnegative().nullable().optional(),
    total_tokens: z.number().int().nonnegative().nullable().optional()
  }).passthrough().optional()
}).passthrough();

export interface OpenAICompatibleClientOptions {
  baseURL: string;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  approvedHeaderNames?: readonly string[];
  extraHeaders?: Readonly<Record<string, string>>;
  fetch?: FetchTransport;
}

export class OpenAICompatibleClient implements LLMClient {
  readonly #endpoint: string;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #extraHeaders: Readonly<Record<string, string>>;
  readonly #fetch: FetchTransport;

  constructor(options: OpenAICompatibleClientOptions) {
    this.#endpoint = normalizeEndpoint(options.baseURL);
    if (options.model.trim().length === 0 || options.model.length > 256) throw invalidConfig("Model must contain 1 to 256 characters.");
    if (options.apiKey.length === 0) throw invalidConfig("API key is required.");
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw invalidConfig("Timeout must be an integer between 1 and 600000 milliseconds.");
    this.#model = options.model;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = timeoutMs;
    this.#extraHeaders = validateHeaders(options.approvedHeaderNames ?? [], options.extraHeaders ?? {});
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async complete(rawRequest: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    const parsedRequest = CompletionRequestSchema.safeParse(rawRequest);
    if (!parsedRequest.success) throw protocolError("Completion request violates the bounded request contract.", parsedRequest.error);
    if (signal?.aborted) throw callerAbortError();

    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    let rejectCancellation: (reason: unknown) => void = () => undefined;
    const onCallerAbort = () => {
      callerAborted = true;
      controller.abort(signal?.reason);
      rejectCancellation(new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timeout", "TimeoutError"));
      rejectCancellation(new DOMException("Request timeout", "TimeoutError"));
    }, this.#timeoutMs);

    try {
      // Responses without any valid tool call (zero calls, or calls whose
      // arguments fail validation) are usually transient sampling failures —
      // re-sampling the identical request often yields a valid action, so
      // retry a bounded number of times before surfacing the error.
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const transport = this.#fetch(this.#endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
              ...this.#extraHeaders
            },
            body: JSON.stringify(toChatCompletionBody(parsedRequest.data, this.#model)),
            signal: controller.signal
          });
          const response = await Promise.race([transport, cancellation]);
          if (!response.ok) throw mapHttpError(response.status);
          const text = await Promise.race([readBoundedResponse(response, controller.signal), cancellation]);
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch (cause) {
            throw protocolError("LLM response is not valid JSON.", cause);
          }
          return parseCompletion(body, parsedRequest.data);
        } catch (cause) {
          const retryableToolCallCount = cause instanceof SentinelError
            && cause.code === "LLM_PROTOCOL"
            && cause.detail !== null
            && typeof cause.detail.toolCallCount === "number";
          if (retryableToolCallCount && !callerAborted && !timedOut && attempt < maxAttempts) continue;
          if (cause instanceof SentinelError) throw cause;
          if (callerAborted || signal?.aborted) throw callerAbortError(cause);
          if (timedOut || isAbortError(cause)) {
            throw new SentinelError({ code: "LLM_TIMEOUT", message: "LLM request timed out.", cause });
          }
          throw new SentinelError({ code: "LLM_UNAVAILABLE", message: "Unable to reach the configured LLM endpoint.", cause });
        }
      }
      throw new SentinelError({ code: "LLM_PROTOCOL", message: "LLM completion retry loop was exhausted without a result." });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

async function readBoundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel("response size limit exceeded");
        throw protocolError("LLM response exceeds the 1 MiB encoded limit.");
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw protocolError("LLM response is not valid UTF-8.", cause);
  }
}

function toChatCompletionBody(request: CompletionRequest, model: string) {
  const { systemGovernance, ...userContext } = request.context;
  return {
    model,
    stream: false,
    tool_choice: "required",
    parallel_tool_calls: false,
    messages: [
      { role: "system", content: systemGovernance },
      { role: "user", content: JSON.stringify({ taskId: request.taskId, phase: request.phase, ...userContext }) }
    ],
    tools: request.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema }
    }))
  };
}

function parseCompletion(raw: unknown, request: CompletionRequest): CompletionResult {
  const response = ResponseSchema.safeParse(raw);
  if (!response.success) throw protocolError("LLM response does not match the Chat Completions contract.", response.error);
  if (response.data.choices.length !== 1) throw protocolError("LLM response must contain exactly one choice.");
  const choice = response.data.choices[0]!;
  if (choice.finish_reason !== "tool_calls") throw protocolError("LLM response used an unsupported finish reason.");
  const calls = choice.message.tool_calls ?? [];
  if (calls.length === 0) throw protocolError("LLM response must contain exactly one tool call.", undefined, { toolCallCount: 0 });
  if (choice.message.content !== undefined && choice.message.content !== null && choice.message.content.trim() !== "") {
    throw protocolError("LLM response cannot mix assistant text with a tool call.");
  }

  // Some endpoints (e.g. DeepSeek) return several tool calls despite
  // parallel_tool_calls=false. The harness executes exactly one governed
  // action per step, so deterministically pick the first call that carries a
  // valid matching action; the remaining intent resurfaces on the next turn
  // once the model observes this step's result.
  const toolNames = new Set(request.tools.map(({ name }) => name));
  let action: Action | null = null;
  let invalidCalls = 0;
  for (const candidate of calls) {
    if (!toolNames.has(candidate.function.name)) {
      invalidCalls += 1;
      continue;
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(candidate.function.arguments);
    } catch {
      invalidCalls += 1;
      continue;
    }
    // Some models occasionally omit the discriminator field even though the
    // tool schema requires it. The harness contract binds action.type to the
    // requested tool name, so default a missing type deterministically.
    if (typeof argumentsValue === "object" && argumentsValue !== null && !Array.isArray(argumentsValue) && !("type" in argumentsValue)) {
      argumentsValue = { ...argumentsValue, type: candidate.function.name };
    }
    const parsed = ActionSchema.safeParse(argumentsValue);
    if (!parsed.success || parsed.data.type !== candidate.function.name) {
      invalidCalls += 1;
      continue;
    }
    action = parsed.data;
    break;
  }
  if (action === null) {
    throw protocolError("LLM tool arguments do not contain one valid matching action.", undefined, { toolCallCount: calls.length, invalidCalls });
  }

  const usage = response.data.usage === undefined ? null : {
    inputTokens: response.data.usage.prompt_tokens ?? null,
    outputTokens: response.data.usage.completion_tokens ?? null,
    totalTokens: response.data.usage.total_tokens ?? null,
    costUsd: null
  };
  const result = CompletionResultSchema.safeParse({
    outcome: "action",
    action,
    providerRequestId: response.data.id ?? null,
    usage
  });
  if (!result.success) throw protocolError("LLM completion result violates the internal contract.", result.error);
  return result.data;
}

function normalizeEndpoint(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch (cause) {
    throw invalidConfig("Base URL must be an absolute HTTP(S) URL.", cause);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw invalidConfig("Base URL must be an HTTP(S) origin/path without credentials, query or fragment.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) throw invalidConfig("Base URL must not include the chat/completions resource path.");
  url.pathname = `${path}/chat/completions`.replace(/\/{2,}/g, "/");
  return url.toString();
}

function validateHeaders(approvedNames: readonly string[], extraHeaders: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const approved = normalizeUniqueHeaderNames(approvedNames, "approved header names");
  const entries = Object.entries(extraHeaders);
  normalizeUniqueHeaderNames(entries.map(([name]) => name), "extra headers");
  const validated: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (!approved.has(lower)) throw invalidConfig("Every extra header must be explicitly approved by name.");
    if (reservedHeaders.has(lower)) throw invalidConfig("Reserved transport headers cannot be configured as extra headers.");
    if (/\r|\n/.test(value)) throw invalidConfig("Extra header values cannot contain line breaks.");
    validated[lower] = value;
  }
  return Object.freeze(validated);
}

function normalizeUniqueHeaderNames(names: readonly string[], label: string): Set<string> {
  const normalized = new Set<string>();
  for (const name of names) {
    if (!headerNamePattern.test(name)) throw invalidConfig(`Invalid ${label}.`);
    const lower = name.toLowerCase();
    if (normalized.has(lower)) throw invalidConfig(`Case-colliding ${label} are not allowed.`);
    if (reservedHeaders.has(lower)) throw invalidConfig("Reserved transport headers cannot be approved or overridden.");
    normalized.add(lower);
  }
  return normalized;
}

function mapHttpError(status: number): SentinelError {
  if (status === 401 || status === 403) return new SentinelError({ code: "LLM_AUTH", message: "The LLM endpoint rejected the configured credentials.", detail: { status } });
  if (status === 429) return new SentinelError({ code: "LLM_RATE_LIMIT", message: "The LLM endpoint rate limit was reached.", detail: { status } });
  if (status >= 500) return new SentinelError({ code: "LLM_UNAVAILABLE", message: "The LLM endpoint is temporarily unavailable.", detail: { status } });
  return protocolError("The LLM endpoint returned an unsupported HTTP response.", undefined, { status });
}

function protocolError(message: string, cause?: unknown, detail: Record<string, number> | null = null): SentinelError {
  return new SentinelError({ code: "LLM_PROTOCOL", message, detail, cause });
}

function invalidConfig(message: string, cause?: unknown): SentinelError {
  return new SentinelError({ code: "INVALID_CONFIG", message, cause });
}

function callerAbortError(cause?: unknown): SentinelError {
  return new SentinelError({ code: "LLM_TIMEOUT", message: "LLM request was aborted by the caller.", retryable: false, cause });
}

function isAbortError(value: unknown): boolean {
  return value instanceof DOMException && value.name === "AbortError";
}

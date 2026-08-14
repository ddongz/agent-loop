import { describe, expect, it, vi } from "vitest";

import { OpenAICompatibleClient } from "../../../src/llm/openai-compatible.js";
import type { CompletionRequest, FetchTransport } from "../../../src/llm/types.js";

function request(): CompletionRequest {
  return {
    schemaVersion: 1,
    taskId: "task-7",
    phase: "IMPLEMENT",
    context: {
      systemGovernance: "Call exactly one available tool.",
      requirement: "Create src/user.ts",
      current: {
        iteration: 1,
        budget: { maxIterations: 8, maxDurationMs: 60_000, maxTokens: null, maxCostUsd: null },
        usage: { iterations: 1, elapsedMs: 100, inputTokens: 0, outputTokens: 0, costUsd: null }
      },
      repositorySummary: "Empty TypeScript project",
      feedback: null,
      events: [],
      observations: []
    },
    tools: [{
      name: "create_file",
      description: "Create one file.",
      inputSchema: { type: "object", additionalProperties: false }
    }]
  };
}

const action = {
  version: 1,
  id: "create-1",
  type: "create_file",
  rationale: "Add the requested module.",
  path: "src/user.ts",
  content: "export const user = true;\n"
};

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-1",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "create_file", arguments: JSON.stringify(action) } }]
      }
    }],
    usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    ...overrides
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(fetch: FetchTransport, options: Record<string, unknown> = {}) {
  return new OpenAICompatibleClient({
    baseURL: "https://llm.example.test/v1/",
    model: "test-model",
    apiKey: "super-secret-key",
    timeoutMs: 1_000,
    fetch,
    ...options
  });
}

describe("OpenAICompatibleClient", () => {
  it("sends one bounded Chat Completions tool-call request and validates its action", async () => {
    const fetch = vi.fn<FetchTransport>(async () => response(completion()));
    const result = await client(fetch).complete(request());
    const [url, init] = fetch.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    expect(url).toBe("https://llm.example.test/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer super-secret-key");
    expect(body).toMatchObject({ model: "test-model", stream: false, tool_choice: "required", parallel_tool_calls: false });
    expect(body.tools).toEqual([{ type: "function", function: { name: "create_file", description: "Create one file.", parameters: { type: "object", additionalProperties: false } } }]);
    expect(result).toEqual({
      outcome: "action",
      action,
      providerRequestId: "chatcmpl-1",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUsd: null }
    });
  });

  it("allows only explicitly approved headers and rejects case collisions", async () => {
    const fetch = vi.fn<FetchTransport>(async () => response(completion()));
    const configured = client(fetch, {
      approvedHeaderNames: ["X-Tenant"],
      extraHeaders: { "x-tenant": "class-a" }
    });
    await configured.complete(request());
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("x-tenant")).toBe("class-a");

    expect(() => client(fetch, { approvedHeaderNames: ["X-Tenant"], extraHeaders: { "X-Tenant": "a", "x-tenant": "b" } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => client(fetch, { approvedHeaderNames: [], extraHeaders: { "X-Tenant": "a" } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(() => client(fetch, { approvedHeaderNames: ["Authorization"], extraHeaders: { Authorization: "other" } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it.each([
    [401, "LLM_AUTH"],
    [403, "LLM_AUTH"],
    [429, "LLM_RATE_LIMIT"],
    [500, "LLM_UNAVAILABLE"],
    [503, "LLM_UNAVAILABLE"]
  ])("maps HTTP %i without leaking credentials", async (status, code) => {
    const fetch: FetchTransport = async () => response({ error: { message: "upstream failed super-secret-key" } }, status);
    const error = await client(fetch).complete(request()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code });
    expect(`${String((error as Error).message)} ${JSON.stringify((error as { detail?: unknown }).detail)}`).not.toContain("super-secret-key");
  });

  it("distinguishes caller abort from request timeout and clears timers", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const neverCalled = vi.fn<FetchTransport>();
    await expect(client(neverCalled).complete(request(), aborted.signal)).rejects.toMatchObject({ code: "LLM_TIMEOUT", retryable: false });
    expect(neverCalled).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      const waitsForAbort: FetchTransport = async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      const pending = client(waitsForAbort, { timeoutMs: 10 }).complete(request());
      const rejection = expect(pending).rejects.toMatchObject({ code: "LLM_TIMEOUT", retryable: true });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces its deadline even when an injected transport ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      const ignoresAbort: FetchTransport = async () => new Promise(() => undefined);
      const pending = client(ignoresAbort, { timeoutMs: 10 }).complete(request());
      const rejection = expect(pending).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 500);

  it("enforces its deadline after headers when the response body stalls", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
        },
        cancel() {
          cancelled = true;
        }
      });
      const stalled: FetchTransport = async () => new Response(body);
      const pending = client(stalled, { timeoutMs: 10 }).complete(request());
      const rejection = expect(pending).rejects.toMatchObject({ code: "LLM_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["zero choices", { choices: [] }],
    ["multiple choices", { choices: completion().choices.concat(completion().choices) }],
    ["unsupported finish reason", { choices: [{ ...completion().choices[0], finish_reason: "length" }] }],
    ["text pretending to be a tool", { choices: [{ ...completion().choices[0], finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(action), tool_calls: [] } }] }],
    ["multiple tool calls", { choices: [{ ...completion().choices[0], message: { ...completion().choices[0]!.message, tool_calls: [completion().choices[0]!.message.tool_calls[0], completion().choices[0]!.message.tool_calls[0]] } }] }],
    ["unknown tool", { choices: [{ ...completion().choices[0], message: { ...completion().choices[0]!.message, tool_calls: [{ ...completion().choices[0]!.message.tool_calls[0], function: { name: "shell", arguments: JSON.stringify(action) } }] } }] }],
    ["invalid JSON", { choices: [{ ...completion().choices[0], message: { ...completion().choices[0]!.message, tool_calls: [{ ...completion().choices[0]!.message.tool_calls[0], function: { name: "create_file", arguments: "{" } }] } }] }],
    ["non-strict action", { choices: [{ ...completion().choices[0], message: { ...completion().choices[0]!.message, tool_calls: [{ ...completion().choices[0]!.message.tool_calls[0], function: { name: "create_file", arguments: JSON.stringify({ ...action, extra: true }) } }] } }] }]
  ])("rejects %s as a protocol error", async (_name, overrides) => {
    const fetch: FetchTransport = async () => response(completion(overrides));
    await expect(client(fetch).complete(request())).rejects.toMatchObject({ code: "LLM_PROTOCOL" });
  });

  it("maps transport failures and rejects oversized responses", async () => {
    const transport: FetchTransport = async () => { throw new TypeError("connect ECONNRESET super-secret-key"); };
    const transportError = await client(transport).complete(request()).catch((caught: unknown) => caught);
    expect(transportError).toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(`${String((transportError as Error).message)} ${JSON.stringify((transportError as { detail?: unknown }).detail)}`).not.toContain("super-secret-key");

    const oversized: FetchTransport = async () => new Response("x".repeat(1_048_577));
    await expect(client(oversized).complete(request())).rejects.toMatchObject({ code: "LLM_PROTOCOL" });
  });

  it("cancels response streaming immediately after the encoded limit", async () => {
    let pullCount = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      }
    });
    const oversized: FetchTransport = async () => new Response(stream);

    await expect(client(oversized).complete(request())).rejects.toMatchObject({ code: "LLM_PROTOCOL" });
    expect(pullCount).toBeGreaterThanOrEqual(2);
    expect(pullCount).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { ActionSchema } from "../../../src/domain/action.js";
import { SentinelError } from "../../../src/domain/error.js";
import { TaskStateSchema } from "../../../src/domain/task.js";

describe("domain contracts", () => {
  it("rejects an unknown action", () => {
    expect(
      ActionSchema.safeParse({
        version: 1,
        id: "a1",
        type: "shell",
        command: "rm -rf /"
      }).success
    ).toBe(false);
  });

  it("provides specified action defaults", () => {
    const action = ActionSchema.parse({
      version: 1,
      id: "a1",
      rationale: "Inspect the source.",
      type: "read_file",
      path: "src/index.ts"
    });

    expect(action.maxBytes).toBe(65_536);
  });

  it("rejects success without final validation", () => {
    expect(() =>
      TaskStateSchema.parse({
        id: "t1",
        phase: "SUCCEEDED",
        finalValidationAt: null
      })
    ).toThrow();
  });

  it("serializes errors after redacting message and detail", () => {
    const error = new SentinelError({
      code: "LLM_AUTH",
      message: "secret-token",
      detail: { token: "secret-token" }
    });

    expect(error.toJSON((value) => (typeof value === "string" ? "[REDACTED]" : { token: "[REDACTED]" }))).toEqual({
      code: "LLM_AUTH",
      message: "[REDACTED]",
      retryable: false,
      recoverable: true,
      detail: { token: "[REDACTED]" }
    });
  });
});

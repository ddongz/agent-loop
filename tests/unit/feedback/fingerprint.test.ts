import { describe, expect, it } from "vitest";

import type { ValidationIssue } from "../../../src/domain/validation.js";
import { fingerprint } from "../../../src/feedback/fingerprint.js";

const issue = (overrides: Partial<ValidationIssue> = {}): ValidationIssue => ({
  category: "TEST_ASSERTION",
  severity: "error",
  message: "expected \"alice-6d6ecb98-625d-4ff2-bc35-260faf42ce8a\" to equal \"bob\" after 42ms at line 18 column 7",
  file: "C:\\runner\\work\\repo\\tests\\user.test.ts",
  line: 18,
  column: 7,
  rule: null,
  testName: "returns user by email",
  fingerprint: "",
  ...overrides,
});
describe("fingerprint", () => {
  it("normalizes platform paths, roots, positions, duration, generated IDs and assertion values", () => {
    const first = fingerprint(issue());
    const second = fingerprint(issue({
      message: "expected \"carol-107f8e4b-91e8-4410-a450-4a8f9ed586f0\" to equal \"dave\" after 903ms at line 99 column 2",
      file: "/tmp/run-9812/repo/tests/user.test.ts",
      line: 99,
      column: 2,
    }));

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it("preserves semantic validator, category, rule, test name, and message identity", () => {
    const base = fingerprint(issue(), { validator: "test" });

    expect(fingerprint(issue({ testName: "deletes user" }), { validator: "test" })).not.toBe(base);
    expect(fingerprint(issue({ category: "TYPE_ERROR", rule: "TS2322", testName: null, message: "Type string is invalid" }), { validator: "typecheck" })).not.toBe(base);
    expect(fingerprint(issue({ category: "TYPE_ERROR", rule: "TS2339", testName: null, message: "Type string is invalid" }), { validator: "typecheck" })).not.toBe(base);
    expect(fingerprint(issue(), { validator: "build" })).not.toBe(base);
  });

  it("strips ANSI/control characters and redacts secrets before hashing", () => {
    const clean = fingerprint(issue({ message: "token [REDACTED] is invalid" }));
    const secret = fingerprint(issue({ message: "\u001b[31mtoken sk-live-abcdef1234567890 is invalid\u0000" }));

    expect(secret).toBe(clean);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseValidation } from "../../../src/feedback/parsers.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/validation/${name}`, import.meta.url), "utf8");

describe("parseValidation", () => {
  it("classifies a realistic ANSI Vitest assertion and its test name", () => {
    const result = parseValidation(fixture("vitest-fail.txt").replaceAll("\n", "\r\n"));

    expect(result.validator).toBe("test");
    expect(result.status).toBe("failed");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      category: "TEST_ASSERTION",
      file: "tests/user-service.test.ts",
      line: 18,
      column: 11,
      testName: "user service > returns user by email",
    });
    expect(result.issues[0]?.message).not.toContain("\u001b");
  });

  it("classifies Jest assertions with Windows stack paths", () => {
    const result = parseValidation(fixture("jest-fail.txt"));

    expect(result.issues[0]).toMatchObject({
      category: "TEST_ASSERTION",
      file: "tests/math.test.ts",
      line: 9,
      column: 17,
      testName: "math service > adds values",
    });
  });

  it("classifies and deduplicates tsc diagnostics", () => {
    const raw = `${fixture("tsc-fail.txt")}\n${fixture("tsc-fail.txt").split("\n")[0]}`;
    const result = parseValidation(raw);

    expect(result.validator).toBe("typecheck");
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]).toMatchObject({ category: "TYPE_ERROR", rule: "TS2322", file: "src/user.ts" });
    expect(result.issues[1]).toMatchObject({ category: "TYPE_ERROR", rule: "TS2339" });
  });

  it("prefers ESLint JSON and retains rule severity", () => {
    const result = parseValidation(fixture("eslint-fail.txt"));

    expect(result.validator).toBe("lint");
    expect(result.issues).toEqual([
      expect.objectContaining({ category: "LINT_ERROR", severity: "error", rule: "@typescript-eslint/no-unused-vars", file: "src/user.ts" }),
      expect.objectContaining({ category: "LINT_ERROR", severity: "warning", rule: "eqeqeq", file: "src/user.ts" }),
    ]);
  });

  it("classifies build dependency failures without exposing temporary roots", () => {
    const result = parseValidation(fixture("build-fail.txt"));

    expect(result.validator).toBe("build");
    expect(result.issues[0]).toMatchObject({ category: "DEPENDENCY_ERROR" });
    expect(result.issues[0]?.message).not.toMatch(/AppData|vite-1937/);
  });

  it("parses structured test reporter JSON before text patterns", () => {
    const raw = JSON.stringify({
      framework: "vitest",
      numFailedTests: 1,
      testResults: [{
        name: "/workspace/tests/account.test.ts",
        assertionResults: [{
          ancestorTitles: ["account"], title: "rejects an expired token", status: "failed",
          failureMessages: ["expected true to be false"], location: { line: 12, column: 4 },
        }],
      }],
    });

    expect(parseValidation(raw).issues[0]).toMatchObject({
      category: "TEST_ASSERTION", testName: "account > rejects an expired token", file: "tests/account.test.ts",
    });
  });

  it.each([
    ["ReferenceError: account is not defined", "TEST_RUNTIME"],
    ["SyntaxError: Unexpected token 'export'", "SYNTAX_ERROR"],
    ["Test timed out in 5000ms", "TIMEOUT"],
  ] as const)("classifies structured test evidence as %s", (message, category) => {
    const raw = JSON.stringify({
      testResults: [{
        name: "/workspace/tests/account.test.ts",
        assertionResults: [{
          ancestorTitles: ["account"], title: "loads", status: "failed",
          failureMessages: [message], location: { line: 2, column: 1 },
        }],
      }],
    });

    expect(parseValidation(raw).issues[0]?.category).toBe(category);
  });

  it("classifies structured discovery and infrastructure failures", () => {
    const discovery = JSON.stringify({
      testResults: [{ name: "/workspace/tests/account.test.ts", assertionResults: [], testExecError: { message: "No tests found in suite" } }],
    });
    const infrastructure = JSON.stringify({
      testResults: [{ name: "/workspace/tests/account.test.ts", assertionResults: [], testExecError: { message: "spawn ENOENT" } }],
    });

    expect(parseValidation(discovery).issues[0]?.category).toBe("TEST_DISCOVERY");
    expect(parseValidation(infrastructure)).toMatchObject({ status: "infrastructure_error" });
    expect(parseValidation(infrastructure).issues[0]?.category).toBe("INFRASTRUCTURE_ERROR");
  });

  it("retains a structured execution failure alongside assertion failures", () => {
    const raw = JSON.stringify({
      testResults: [{
        name: "/workspace/tests/account.test.ts",
        testExecError: { message: "Worker crashed with code 1" },
        assertionResults: [{
          ancestorTitles: ["account"], title: "loads", status: "failed",
          failureMessages: ["Expected: true Received: false"], location: { line: 2, column: 1 },
        }],
      }],
    });
    const parsed = parseValidation(raw);

    expect(parsed.status).toBe("infrastructure_error");
    expect(parsed.issues.map(({ category }) => category).sort()).toEqual(["INFRASTRUCTURE_ERROR", "TEST_ASSERTION"]);
  });

  it("returns every deterministic Vitest failure block and deduplicates repeats", () => {
    const blockA = "FAIL tests/b.test.ts > beta > fails\nAssertionError: expected 1 to be 2\n ❯ tests/b.test.ts:9:2";
    const blockB = "FAIL tests/a.test.ts > alpha > fails\nAssertionError: expected true to be false\n ❯ tests/a.test.ts:3:4";
    const result = parseValidation(`${blockA}\n${blockB}\n${blockA}`);

    expect(result.issues.map(({ testName }) => testName)).toEqual(["alpha > fails", "beta > fails"]);
  });

  it("returns every deterministic Jest failure block", () => {
    const raw = [
      "FAIL tests/multi.test.ts",
      "  ● beta › fails",
      "    Expected: 1",
      "    Received: 2",
      "      at Object.<anonymous> (tests/multi.test.ts:9:2)",
      "  ● alpha › fails",
      "    Expected: true",
      "    Received: false",
      "      at Object.<anonymous> (tests/multi.test.ts:3:4)",
    ].join("\n");

    expect(parseValidation(raw).issues.map(({ testName }) => testName)).toEqual(["alpha > fails", "beta > fails"]);
  });

  it.each([
    "Error: Test timed out in 5000ms",
    "Error: Exceeded timeout of 10000 ms for a test",
    "The operation was aborted due to timeout",
  ])("maps timeout/cancel evidence to TIMEOUT", (message) => {
    const raw = `FAIL tests/slow.test.ts > slow > waits\n${message}\n ❯ tests/slow.test.ts:2:1`;
    expect(parseValidation(raw).issues[0]?.category).toBe("TIMEOUT");
  });

  it("does not steal an ordinary assertion merely because its values mention timeout", () => {
    const raw = "FAIL tests/message.test.ts > message > compares\nAssertionError: expected 'timeout' to be 'done'\n ❯ tests/message.test.ts:2:1";
    expect(parseValidation(raw).issues[0]?.category).toBe("TEST_ASSERTION");
  });

  it("recognizes standard Jest JSON without a nonstandard framework marker", () => {
    const raw = JSON.stringify({
      numFailedTests: 1,
      testResults: [{
        name: "/workspace/tests/account.test.ts",
        assertionResults: [{
          ancestorTitles: ["account"], title: "rejects an expired token", status: "failed",
          failureMessages: ["Expected: false Received: true"], location: { line: 12, column: 4 },
        }],
      }],
    });

    expect(parseValidation(raw)).toMatchObject({ validator: "test", status: "failed" });
  });

  it.each(["{not-json", "", "totally unfamiliar validator output\u0000with controls"])(
    "returns a bounded UNKNOWN issue for malformed, empty, or unknown output",
    (raw) => {
      const result = parseValidation(raw, { validator: "build", exitCode: 1 });

      expect(result.issues[0]).toMatchObject({ category: "UNKNOWN", severity: "error" });
      expect(Buffer.byteLength(result.stderrSummary, "utf8")).toBeLessThanOrEqual(2_048);
      expect(result.stderrSummary).not.toContain("\u0000");
    },
  );

  it("maps infrastructure output separately and redacts secret-like values", () => {
    const result = parseValidation("spawn ENOENT Authorization: Bearer sk-live-super-secret", {
      validator: "build", exitCode: null,
    });

    expect(result.status).toBe("infrastructure_error");
    expect(result.issues[0]?.category).toBe("INFRASTRUCTURE_ERROR");
    expect(JSON.stringify(result)).not.toContain("sk-live-super-secret");
    expect(result.stderrSummary).toContain("[REDACTED]");
  });

  it("returns no issue for a successful empty validator result", () => {
    expect(parseValidation("", { validator: "build", exitCode: 0 })).toMatchObject({ status: "passed", issues: [] });
  });

  it("preserves a runner result's null exit code for infrastructure failures", () => {
    const result = parseValidation({
      validator: "build",
      status: "infrastructure_error",
      exitCode: null,
      command: { executable: "npm", args: ["run", "build"] },
      startedAt: "2026-08-14T00:00:00.000Z",
      durationMs: 10,
      issues: [],
      stdoutSummary: "",
      stderrSummary: "spawn ENOENT",
      stdoutTruncated: false,
      stderrTruncated: false,
    });

    expect(result).toMatchObject({ status: "infrastructure_error", exitCode: null });
  });

  it.each([
    ["passed", 1, "failed"],
    ["failed", 0, "failed"],
    ["passed", null, "infrastructure_error"],
    ["infrastructure_error", 0, "infrastructure_error"],
  ] as const)("resolves contradictory inherited status %s and exit %s conservatively", (status, exitCode, expected) => {
    const parsed = parseValidation({
      validator: "build", status, exitCode,
      command: { executable: "npm", args: ["run", "build"] },
      startedAt: "2026-08-14T00:00:00.000Z", durationMs: 1, issues: [],
      stdoutSummary: "", stderrSummary: "build failed", stdoutTruncated: false, stderrTruncated: false,
    });

    expect(parsed.status).toBe(expected);
  });

  it("marks parser-side summary truncation and bounds deterministic issue arrays", () => {
    const diagnostics = Array.from({ length: 130 }, (_, index) =>
      `src/file-${index.toString().padStart(3, "0")}.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.`,
    ).reverse().join("\n");
    const parsed = parseValidation({
      validator: "typecheck", status: "failed", exitCode: 1,
      command: { executable: "npm", args: ["run", "typecheck"] },
      startedAt: "2026-08-14T00:00:00.000Z", durationMs: 1, issues: [],
      stdoutSummary: `${diagnostics}\n${"x".repeat(3_000)}`, stderrSummary: "", stdoutTruncated: false, stderrTruncated: false,
    });

    expect(parsed.stdoutTruncated).toBe(true);
    expect(parsed.issues).toHaveLength(100);
    expect(parsed.issues[0]?.file).toBe("src/file-000.ts");
    expect(parsed.issues.at(-1)?.file).toBe("src/file-099.ts");
  });
});

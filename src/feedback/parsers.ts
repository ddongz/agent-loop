import type {
  ValidationIssue,
  ValidationIssueCategory,
  ValidationResult,
  ValidatorName,
} from "../domain/validation.js";
import { fingerprint, normalizeMessage, normalizePath, sanitizeText } from "./fingerprint.js";

const summaryLimitBytes = 2_048;
const epoch = "1970-01-01T00:00:00.000Z";

export interface ParseValidationMetadata {
  validator?: ValidatorName;
  exitCode?: number | null;
  command?: ValidationResult["command"];
  startedAt?: string;
  durationMs?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

type DraftIssue = Omit<ValidationIssue, "fingerprint">;

export function parseValidation(
  raw: string | ValidationResult,
  metadata: ParseValidationMetadata = {},
): ValidationResult {
  try {
    const source = typeof raw === "string" ? raw : `${raw.stdoutSummary}\n${raw.stderrSummary}`;
    const clean = sanitizeText(source);
    const inherited = typeof raw === "string" ? undefined : raw;
    const validator = metadata.validator ?? inherited?.validator ?? inferValidator(clean);
    const exitCode = metadata.exitCode !== undefined ? metadata.exitCode : inherited !== undefined ? inherited.exitCode : 1;
    const status = determineStatus(exitCode, inherited?.status, clean);
    const drafts = status === "passed" ? [] : status === "infrastructure_error"
      ? [infrastructureIssue(clean)]
      : parseIssues(clean, validator);
    const issues = deduplicateAndSort(drafts.map((draft) => withFingerprint(draft, validator)));

    return {
      validator,
      status,
      exitCode,
      command: metadata.command ?? inherited?.command ?? { executable: validator, args: [] },
      startedAt: metadata.startedAt ?? inherited?.startedAt ?? epoch,
      durationMs: metadata.durationMs ?? inherited?.durationMs ?? 0,
      issues,
      stdoutSummary: bounded(inherited?.stdoutSummary ?? "", summaryLimitBytes),
      stderrSummary: bounded(inherited?.stderrSummary ?? clean, summaryLimitBytes),
      stdoutTruncated: metadata.stdoutTruncated ?? inherited?.stdoutTruncated ?? false,
      stderrTruncated: metadata.stderrTruncated ?? inherited?.stderrTruncated ?? Buffer.byteLength(clean, "utf8") > summaryLimitBytes,
    };
  } catch {
    const clean = sanitizeText(typeof raw === "string" ? raw : `${raw.stdoutSummary}\n${raw.stderrSummary}`);
    const validator = metadata.validator ?? (typeof raw === "string" ? inferValidator(clean) : raw.validator);
    const draft = unknownIssue(clean);
    return {
      validator,
      status: metadata.exitCode === null ? "infrastructure_error" : "failed",
      exitCode: metadata.exitCode ?? (typeof raw === "string" ? 1 : raw.exitCode),
      command: metadata.command ?? (typeof raw === "string" ? { executable: validator, args: [] } : raw.command),
      startedAt: metadata.startedAt ?? (typeof raw === "string" ? epoch : raw.startedAt),
      durationMs: metadata.durationMs ?? (typeof raw === "string" ? 0 : raw.durationMs),
      issues: [withFingerprint(draft, validator)],
      stdoutSummary: "",
      stderrSummary: bounded(clean, summaryLimitBytes),
      stdoutTruncated: false,
      stderrTruncated: Buffer.byteLength(clean, "utf8") > summaryLimitBytes,
    };
  }
}

function determineStatus(
  exitCode: number | null,
  inherited: ValidationResult["status"] | undefined,
  clean: string,
): ValidationResult["status"] {
  if (exitCode === null || inherited === "infrastructure_error" || isInfrastructureOutput(clean)) return "infrastructure_error";
  if (exitCode === 0 || inherited === "passed") return "passed";
  return "failed";
}

function parseIssues(raw: string, validator: ValidatorName): DraftIssue[] {
  const structured = parseStructured(raw, validator);
  if (structured !== null) return structured.length > 0 ? structured : [unknownIssue(raw)];
  const parsed = validator === "typecheck"
    ? parseTsc(raw)
    : validator === "lint"
      ? parseEslintText(raw)
      : validator === "test"
        ? parseTestText(raw)
        : parseBuild(raw);
  return parsed.length > 0 ? parsed : [unknownIssue(raw)];
}

function parseStructured(raw: string, validator: ValidatorName): DraftIssue[] | null {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (Array.isArray(value) && value.every((entry) => isRecord(entry) && "filePath" in entry)) {
    return parseEslintJson(value);
  }
  if (isRecord(value) && Array.isArray(value.testResults)) {
    return parseTestJson(value.testResults);
  }
  return validator === "lint" ? [] : null;
}

function parseEslintJson(entries: unknown[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.filePath !== "string" || !Array.isArray(entry.messages)) continue;
    for (const message of entry.messages) {
      if (!isRecord(message) || typeof message.message !== "string") continue;
      issues.push(draft({
        category: message.fatal === true ? "SYNTAX_ERROR" : "LINT_ERROR",
        severity: message.severity === 1 ? "warning" : "error",
        message: message.message,
        file: entry.filePath,
        line: integerOrNull(message.line),
        column: integerOrNull(message.column),
        rule: typeof message.ruleId === "string" ? message.ruleId : null,
      }));
    }
  }
  return issues;
}

function parseTestJson(testResults: unknown[]): DraftIssue[] {
  const issues: DraftIssue[] = [];
  for (const testResult of testResults) {
    if (!isRecord(testResult) || !Array.isArray(testResult.assertionResults)) continue;
    const file = typeof testResult.name === "string" ? testResult.name : null;
    for (const assertion of testResult.assertionResults) {
      if (!isRecord(assertion) || assertion.status !== "failed") continue;
      const ancestors = Array.isArray(assertion.ancestorTitles)
        ? assertion.ancestorTitles.filter((item): item is string => typeof item === "string")
        : [];
      const title = typeof assertion.title === "string" ? assertion.title : "unknown test";
      const failureMessages = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages.filter((item): item is string => typeof item === "string")
        : [];
      const location = isRecord(assertion.location) ? assertion.location : {};
      issues.push(draft({
        category: "TEST_ASSERTION",
        message: failureMessages[0] ?? `Test failed: ${[...ancestors, title].join(" > ")}`,
        file,
        line: integerOrNull(location.line),
        column: integerOrNull(location.column),
        testName: [...ancestors, title].join(" > "),
      }));
    }
  }
  return issues;
}

function parseTsc(raw: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gim;
  for (const match of raw.matchAll(pattern)) {
    issues.push(draft({
      category: /(?:TS1\d{3}|syntax)/i.test(match[5] ?? "") ? "SYNTAX_ERROR" : "TYPE_ERROR",
      severity: match[4]?.toLowerCase() === "warning" ? "warning" : "error",
      message: match[6] ?? "TypeScript validation failed.",
      file: match[1] ?? null,
      line: numberOrNull(match[2]),
      column: numberOrNull(match[3]),
      rule: match[5] ?? null,
    }));
  }
  return issues;
}

function parseEslintText(raw: string): DraftIssue[] {
  const issues: DraftIssue[] = [];
  let currentFile: string | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (/^(?:[a-z]:[\\/]|\/).+\.[cm]?[jt]sx?$/i.test(trimmed)) {
      currentFile = trimmed;
      continue;
    }
    const match = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/i);
    if (match === null) continue;
    issues.push(draft({
      category: "LINT_ERROR",
      severity: match[3]?.toLowerCase() === "warning" ? "warning" : "error",
      message: match[4] ?? "Lint validation failed.",
      file: currentFile,
      line: numberOrNull(match[1]),
      column: numberOrNull(match[2]),
      rule: match[5] ?? null,
    }));
  }
  return issues;
}

function parseTestText(raw: string): DraftIssue[] {
  const vitest = raw.match(/^\s*FAIL\s+(.+?)\s+>\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*ms)?\s*$/im);
  if (vitest !== null) {
    const location = findLocation(raw, vitest[1] ?? null);
    return [draft({
      category: testCategory(raw),
      message: assertionMessage(raw),
      file: location.file ?? vitest[1] ?? null,
      line: location.line,
      column: location.column,
      testName: (vitest[2] ?? "unknown test").trim(),
    })];
  }
  const jestFile = raw.match(/^\s*FAIL\s+(.+?)\s*$/im);
  const jestName = raw.match(/^\s*●\s+(.+?)\s*$/m);
  if (jestFile !== null || jestName !== null) {
    const location = findLocation(raw, jestFile?.[1] ?? null);
    return [draft({
      category: testCategory(raw),
      message: assertionMessage(raw),
      file: location.file ?? jestFile?.[1] ?? null,
      line: location.line,
      column: location.column,
      testName: jestName?.[1]?.replaceAll("›", ">").replace(/\s*>\s*/g, " > ") ?? "unknown test",
    })];
  }
  return [];
}

function parseBuild(raw: string): DraftIssue[] {
  const dependency = raw.match(/(?:Error:\s*)?(Cannot find (?:module|package)\s+['"][^'"]+['"])/i);
  if (dependency !== null) return [draft({ category: "DEPENDENCY_ERROR", message: dependency[1] ?? "Build dependency missing." })];
  const message = raw.match(/^\s*(?:error during build:|(?:build\s+)?(?:error|fatal):)\s*(.+)$/im)?.[1];
  return message === undefined ? [] : [draft({ category: "BUILD_ERROR", message })];
}

function findLocation(raw: string, preferredFile: string | null): { file: string | null; line: number | null; column: number | null } {
  const matches = Array.from(raw.matchAll(/((?:[a-z]:)?[^\s()]+\.[cm]?[jt]sx?):(\d+):(\d+)/gi));
  const preferred = matches.find((match) => preferredFile !== null && normalizePath(match[1] ?? null) === normalizePath(preferredFile));
  const match = preferred ?? matches.at(-1);
  return { file: match?.[1] ?? preferredFile, line: numberOrNull(match?.[2]), column: numberOrNull(match?.[3]) };
}

function assertionMessage(raw: string): string {
  const assertion = raw.match(/^(?:AssertionError:\s*)?(.*(?:expected|received|expect\().*)$/im)?.[1];
  if (assertion !== undefined) return assertion;
  return raw.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Error:")) ?? "Test assertion failed.";
}

function testCategory(raw: string): ValidationIssueCategory {
  if (/no tests found|test files? not found|failed to discover/i.test(raw)) return "TEST_DISCOVERY";
  if (/syntaxerror|parse error|unexpected token/i.test(raw)) return "SYNTAX_ERROR";
  if (/assertionerror|expected|received|expect\(/i.test(raw)) return "TEST_ASSERTION";
  return "TEST_RUNTIME";
}

function infrastructureIssue(raw: string): DraftIssue {
  return draft({
    category: "INFRASTRUCTURE_ERROR",
    message: raw.trim().split("\n")[0] || "Validator infrastructure failed without output.",
  });
}

function unknownIssue(raw: string): DraftIssue {
  return draft({ category: "UNKNOWN", message: bounded(raw.trim(), 512) || "Validator failed without recognizable output." });
}

function draft(overrides: Partial<DraftIssue> & Pick<DraftIssue, "category" | "message">): DraftIssue {
  return {
    category: overrides.category,
    severity: overrides.severity ?? "error",
    message: normalizeMessage(overrides.message),
    file: normalizePath(overrides.file ?? null),
    line: overrides.line ?? null,
    column: overrides.column ?? null,
    rule: overrides.rule?.trim() || null,
    testName: overrides.testName?.trim() || null,
  };
}

function withFingerprint(issue: DraftIssue, validator: ValidatorName): ValidationIssue {
  const complete = { ...issue, fingerprint: "" };
  return { ...complete, fingerprint: fingerprint(complete, { validator }) };
}

function deduplicateAndSort(issues: ValidationIssue[]): ValidationIssue[] {
  const unique = new Map<string, ValidationIssue>();
  for (const issue of issues) if (!unique.has(issue.fingerprint)) unique.set(issue.fingerprint, issue);
  return [...unique.values()].sort((left, right) => issueKey(left).localeCompare(issueKey(right), "en"));
}

function issueKey(issue: ValidationIssue): string {
  return [issue.file ?? "", String(issue.line ?? -1).padStart(10, "0"), issue.category, issue.rule ?? "", issue.testName ?? "", issue.fingerprint].join("\u0001");
}

function inferValidator(raw: string): ValidatorName {
  if (/\b(?:error|warning)\s+TS\d+:/i.test(raw)) return "typecheck";
  if (/"filePath"\s*:|\b(?:eslint|\d+:\d+\s+(?:error|warning).{2,}\S+)\b/i.test(raw)) return "lint";
  if (/\b(?:vitest|jest)\b|"(?:testResults|assertionResults)"\s*:|^\s*FAIL\s+.*(?:\s>\s|\.[cm]?[jt]sx?\s*$)|^\s*●\s+/im.test(raw)) return "test";
  return "build";
}

function isInfrastructureOutput(raw: string): boolean {
  return /\b(?:spawn\s+ENOENT|command not found|could not be started|infrastructure failure)\b/i.test(raw);
}

function bounded(value: string, limit: number): string {
  const clean = sanitizeText(value);
  if (Buffer.byteLength(clean, "utf8") <= limit) return clean;
  let result = "";
  for (const character of clean) {
    if (Buffer.byteLength(result + character, "utf8") > limit) break;
    result += character;
  }
  return result;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

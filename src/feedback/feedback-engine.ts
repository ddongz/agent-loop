import type {
  Feedback,
  Progress,
  ValidationIssue,
  ValidationResult,
  ValidatorName,
} from "../domain/validation.js";
import { normalizePath, sanitizeText } from "./fingerprint.js";
import { detectProgress, hasUnchangedStreak, type ProgressSnapshot } from "./progress.js";

const feedbackLimitBytes = 8 * 1_024;
const validatorOrder: readonly ValidatorName[] = ["test", "typecheck", "lint", "build"];

export type FeedbackHistoryEntry = ProgressSnapshot;

export interface FeedbackUsage {
  iterations: number;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export interface FeedbackBudget {
  maxIterations?: number;
  maxDurationMs?: number | null;
  maxTokens?: number | null;
  maxCostUsd?: number | null;
}

export interface FeedbackEngineOptions {
  now?: () => string;
  budget?: FeedbackBudget;
  enabledValidators?: readonly ValidatorName[];
}

export type FeedbackDecision = Feedback;

export class FeedbackEngine {
  readonly #now: () => string;
  readonly #budget: Required<Pick<FeedbackBudget, "maxIterations">> & Omit<FeedbackBudget, "maxIterations">;
  readonly #enabledValidators: readonly ValidatorName[];

  constructor(options: FeedbackEngineOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#budget = { maxIterations: options.budget?.maxIterations ?? 8, ...options.budget };
    const enabled = options.enabledValidators ?? validatorOrder;
    if (enabled.length === 0) throw new Error("At least one enabled validator is required.");
    if (new Set(enabled).size !== enabled.length) throw new Error("Enabled validators cannot contain duplicates.");
    if (enabled.some((validator) => !validatorOrder.includes(validator))) throw new Error("Enabled validator is not supported.");
    this.#enabledValidators = [...enabled];
  }

  evaluate(
    results: readonly ValidationResult[],
    history: readonly FeedbackHistoryEntry[],
    diff: string,
    usage: FeedbackUsage = { iterations: history.length + 1 },
  ): FeedbackDecision {
    const sanitizedIssues = sanitizeIssues(results.flatMap(({ issues }) => issues));
    const current: ProgressSnapshot = { results: sanitizedResults(results, sanitizedIssues), diff: sanitizeText(diff) };
    const snapshots = [...history, current];
    const progress = history.length === 0 ? null : detectProgress(snapshots);
    const remainingIterations = Math.max(0, this.#budget.maxIterations - usage.iterations);
    const decision = this.#decide(results, snapshots, usage);
    const currentSet = fingerprints(current);
    const previousSet = history.length === 0 ? [] : fingerprints(history.at(-1) as FeedbackHistoryEntry);
    const resolved = difference(previousSet, currentSet);
    const introduced = difference(currentSet, previousSet);
    const repeated = intersection(currentSet, previousSet);
    const summary = buildSummary({
      decision,
      issues: sanitizedIssues,
      progress,
      resolved,
      introduced,
      repeated,
      usage,
      budget: this.#budget,
      remainingIterations,
    });

    return {
      decision,
      summary,
      currentStage: currentStage(results),
      progress,
      issues: sanitizedIssues,
      remainingIterations,
      createdAt: this.#now(),
    };
  }

  #decide(
    results: readonly ValidationResult[],
    snapshots: readonly ProgressSnapshot[],
    usage: FeedbackUsage,
  ): Feedback["decision"] {
    if (results.some((result) => result.status === "infrastructure_error" || result.issues.some(({ category }) => category === "INFRASTRUCTURE_ERROR"))) {
      return "FAIL_INFRASTRUCTURE";
    }
    if (isExactSuccess(results, this.#enabledValidators)) return "REQUEST_SUCCESS_CHECK";
    if (budgetExhausted(this.#budget, usage)) return "PAUSE_BUDGET";
    const progress = snapshots.length > 1 ? detectProgress(snapshots) : null;
    if (progress?.kind === "oscillating" || hasUnchangedStreak(snapshots, 3)) return "PAUSE_NO_PROGRESS";
    return "CONTINUE";
  }
}

interface SummaryInput {
  decision: Feedback["decision"];
  issues: readonly ValidationIssue[];
  progress: Progress | null;
  resolved: readonly string[];
  introduced: readonly string[];
  repeated: readonly string[];
  usage: FeedbackUsage;
  budget: FeedbackBudget & { maxIterations: number };
  remainingIterations: number;
}

function buildSummary(input: SummaryInput): string {
  const categoryCounts = new Map<string, number>();
  for (const issue of input.issues) categoryCounts.set(issue.category, (categoryCounts.get(issue.category) ?? 0) + 1);
  const categories = [...categoryCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([category, count]) => `${category}:${count}`)
    .join(",");
  const heading = input.decision === "FAIL_INFRASTRUCTURE"
    ? "Infrastructure validation failed; code repair is not requested."
    : input.decision === "REQUEST_SUCCESS_CHECK"
      ? "All validators passed; request the deterministic success gate."
      : input.decision === "PAUSE_BUDGET"
        ? "Budget exhausted; pause before another repair iteration."
        : input.decision === "PAUSE_NO_PROGRESS"
          ? "No deterministic progress; pause the repair loop."
          : "Validation feedback is ready for the next repair iteration.";
  const parts = [
    heading,
    `decision=${input.decision}`,
    `progress=${input.progress?.kind ?? "initial"}`,
    `resolved=${list(input.resolved)}`,
    `new=${list(input.introduced)}`,
    `repeated=${list(input.repeated)}`,
    `categories=${categories || "none"}`,
    budgetSummary(input.usage, input.budget, input.remainingIterations),
  ];
  if (input.issues.length > 0) {
    parts.push("issues:");
    for (const issue of input.issues) {
      parts.push(`- ${issue.fingerprint} ${issue.category} ${bounded(issue.message, 240)}`);
    }
  }
  return bounded(parts.join("\n"), feedbackLimitBytes);
}

function budgetSummary(usage: FeedbackUsage, budget: FeedbackBudget & { maxIterations: number }, remaining: number): string {
  const fields = [`iterations=${usage.iterations}/${budget.maxIterations}; remaining=${remaining}`];
  if (budget.maxDurationMs !== undefined && budget.maxDurationMs !== null) fields.push(`elapsedMs=${usage.elapsedMs ?? 0}/${budget.maxDurationMs}`);
  if (budget.maxTokens !== undefined && budget.maxTokens !== null) fields.push(`tokens=${(usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)}/${budget.maxTokens}`);
  if (budget.maxCostUsd !== undefined && budget.maxCostUsd !== null) fields.push(`costUsd=${usage.costUsd ?? 0}/${budget.maxCostUsd}`);
  return fields.join("; ");
}

function budgetExhausted(budget: FeedbackBudget & { maxIterations: number }, usage: FeedbackUsage): boolean {
  if (usage.iterations >= budget.maxIterations) return true;
  if (budget.maxDurationMs !== undefined && budget.maxDurationMs !== null && (usage.elapsedMs ?? 0) >= budget.maxDurationMs) return true;
  if (budget.maxTokens !== undefined && budget.maxTokens !== null && (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) >= budget.maxTokens) return true;
  return budget.maxCostUsd !== undefined
    && budget.maxCostUsd !== null
    && usage.costUsd !== null
    && (usage.costUsd ?? 0) >= budget.maxCostUsd;
}

function sanitizedResults(results: readonly ValidationResult[], issues: ValidationIssue[]): ValidationResult[] {
  const byFingerprint = new Map(issues.map((issue) => [issue.fingerprint, issue]));
  return results.map((result) => ({
    ...result,
    command: { executable: sanitizeText(result.command.executable), args: result.command.args.map(sanitizeText) },
    issues: result.issues.flatMap((issue) => {
      const retained = byFingerprint.get(sanitizeText(issue.fingerprint));
      return retained === undefined ? [] : [retained];
    }),
    stdoutSummary: sanitizeText(result.stdoutSummary),
    stderrSummary: sanitizeText(result.stderrSummary),
  }));
}

function sanitizeIssues(issues: readonly ValidationIssue[]): ValidationIssue[] {
  const unique = new Map<string, ValidationIssue>();
  for (const issue of issues) {
    const sanitized = sanitizeIssue(issue);
    if (!unique.has(sanitized.fingerprint)) unique.set(sanitized.fingerprint, sanitized);
  }
  return [...unique.values()].sort((left, right) => left.fingerprint.localeCompare(right.fingerprint, "en")).slice(0, 100);
}

function sanitizeIssue(issue: ValidationIssue): ValidationIssue {
  return {
    ...issue,
    message: sanitizeText(issue.message),
    file: normalizePath(issue.file),
    rule: issue.rule === null ? null : sanitizeText(issue.rule),
    testName: issue.testName === null ? null : sanitizeText(issue.testName),
    fingerprint: sanitizeText(issue.fingerprint),
  };
}

function currentStage(results: readonly ValidationResult[]): ValidatorName | null {
  for (const validator of validatorOrder) {
    if (results.some((result) => result.validator === validator && result.status !== "passed")) return validator;
  }
  return null;
}

function fingerprints(snapshot: ProgressSnapshot): string[] {
  return [...new Set(snapshot.results.flatMap(({ issues }) => issues.map(({ fingerprint }) => fingerprint)))].sort();
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(",");
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

function isExactSuccess(results: readonly ValidationResult[], enabled: readonly ValidatorName[]): boolean {
  if (results.length !== enabled.length || results.some(({ status, issues }) => status !== "passed" || issues.length > 0)) return false;
  const validators = results.map(({ validator }) => validator);
  return new Set(validators).size === validators.length && enabled.every((validator) => validators.includes(validator));
}

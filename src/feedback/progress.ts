import { createHash } from "node:crypto";

import type { Progress, ValidationResult, ValidatorName } from "../domain/validation.js";
import { normalizePath } from "./fingerprint.js";

export interface ProgressSnapshot {
  results: readonly ValidationResult[];
  diff: string;
}

const validatorOrder: readonly ValidatorName[] = ["test", "typecheck", "lint", "build"];

export function detectProgress(history: readonly ProgressSnapshot[]): Progress {
  if (history.length === 0) return { kind: "unchanged", repeated: [] };
  const current = history.at(-1) as ProgressSnapshot;
  const previous = history.at(-2);
  const currentSet = fingerprintSet(current);
  if (previous === undefined) return { kind: "regressed", introduced: [...currentSet] };

  const previousSet = fingerprintSet(previous);
  const resolved = difference(previousSet, currentSet);
  const introduced = difference(currentSet, previousSet);
  const stageComparison = stageRank(current) - stageRank(previous);
  if (stageComparison > 0) return { kind: "improved", resolved, introduced };
  if (stageComparison < 0) return { kind: "regressed", introduced };

  const statusComparison = statusScore(current) - statusScore(previous);
  if (statusComparison > 0) return { kind: "improved", resolved, introduced };
  if (statusComparison < 0) return { kind: "regressed", introduced };

  const severityComparison = severityScore(previous) - severityScore(current);
  if (severityComparison > 0) return { kind: "improved", resolved, introduced };
  if (severityComparison < 0) return { kind: "regressed", introduced };

  const canonicalHistory = history.map(canonicalFailureSet);
  const cycleLength = detectCycle(canonicalHistory);
  if (cycleLength !== null) return { kind: "oscillating", cycleLength };

  if (resolved.length === 0 && introduced.length === 0) {
    if (diffSignal(current.diff) !== diffSignal(previous.diff)) return { kind: "improved", resolved: [], introduced: [] };
    return { kind: "unchanged", repeated: [...currentSet] };
  }
  if (introduced.length === 0 || resolved.length > introduced.length) {
    return { kind: "improved", resolved, introduced };
  }
  return { kind: "regressed", introduced };
}

export function canonicalFailureSet(snapshot: ProgressSnapshot): string {
  return JSON.stringify(fingerprintSet(snapshot));
}

export function canonicalProgressSignature(snapshot: ProgressSnapshot): string {
  return JSON.stringify({
    stage: stageRank(snapshot),
    statuses: normalizedStatuses(snapshot),
    severities: normalizedSeverities(snapshot),
    fingerprints: fingerprintSet(snapshot),
    diff: diffSignal(snapshot.diff),
  });
}

export function hasUnchangedStreak(history: readonly ProgressSnapshot[], length = 3): boolean {
  if (history.length < length) return false;
  const tail = history.slice(-length).map(canonicalProgressSignature);
  return new Set(tail).size === 1;
}

function detectCycle(signatures: readonly string[]): 2 | 3 | null {
  for (const length of [2, 3] as const) {
    if (signatures.length < length * 2) continue;
    const first = signatures.slice(-length * 2, -length);
    const second = signatures.slice(-length);
    if (first.every((signature, index) => signature === second[index]) && new Set(second).size > 1) return length;
  }
  return null;
}

function fingerprintSet(snapshot: ProgressSnapshot): string[] {
  return [...new Set(snapshot.results.flatMap(({ issues }) => issues.map(({ fingerprint }) => fingerprint)))].sort();
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function stageRank(snapshot: ProgressSnapshot): number {
  const failedRanks = snapshot.results
    .filter(({ status }) => status !== "passed")
    .map(({ validator }) => validatorOrder.indexOf(validator))
    .filter((rank) => rank >= 0);
  return failedRanks.length === 0 ? validatorOrder.length : Math.min(...failedRanks);
}

function statusScore(snapshot: ProgressSnapshot): number {
  const scores: Record<ValidationResult["status"], number> = { infrastructure_error: 0, failed: 1, passed: 2 };
  return normalizedStatuses(snapshot).reduce((sum, [, status]) => sum + scores[status], 0);
}

function severityScore(snapshot: ProgressSnapshot): number {
  return normalizedSeverities(snapshot).reduce((sum, [, severity]) => sum + severity, 0);
}

function normalizedStatuses(snapshot: ProgressSnapshot): [ValidatorName, ValidationResult["status"]][] {
  const scores: Record<ValidationResult["status"], number> = { infrastructure_error: 0, failed: 1, passed: 2 };
  const statuses = new Map<ValidatorName, ValidationResult["status"]>();
  for (const result of snapshot.results) {
    const current = statuses.get(result.validator);
    if (current === undefined || scores[result.status] < scores[current]) statuses.set(result.validator, result.status);
  }
  return validatorOrder.flatMap((validator) => {
    const status = statuses.get(validator);
    return status === undefined ? [] : [[validator, status] as [ValidatorName, ValidationResult["status"]]];
  });
}

function normalizedSeverities(snapshot: ProgressSnapshot): [string, number][] {
  const severities = new Map<string, number>();
  for (const issue of snapshot.results.flatMap(({ issues }) => issues)) {
    severities.set(issue.fingerprint, Math.max(severities.get(issue.fingerprint) ?? 0, issue.severity === "error" ? 2 : 1));
  }
  return [...severities.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
}

function diffSignal(diff: string): string | null {
  const normalized = diff
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .filter((line) => line !== "\\ No newline at end of file")
    .map((line) => normalizeDiffHeader(line)
      .replace(/^index\s+[0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?$/i, "index <content>")
      .replace(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/, "@@")
      .replace(/^((?:---|\+\+)\s+\S+)\t.*$/, "$1"))
    .join("\n")
    .trim();
  if (normalized === "") return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function normalizeDiffHeader(line: string): string {
  const match = line.match(/^(---|\+\+\+)\s+(.+?)(?:\t.*)?$/);
  if (match === null) return line;
  return `${match[1]} ${normalizePath(match[2] ?? null) ?? "/dev/null"}`;
}

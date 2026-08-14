import { createHash } from "node:crypto";

import type { ValidationIssue, ValidatorName } from "../domain/validation.js";

export interface FingerprintOptions {
  validator?: ValidatorName;
}

const repositoryAnchors = ["src", "tests", "test", "__tests__", "lib", "app"];

export function fingerprint(issue: ValidationIssue, options: FingerprintOptions = {}): string {
  const identity = {
    validator: options.validator ?? inferValidator(issue),
    category: issue.category,
    file: normalizePath(issue.file),
    rule: issue.rule?.trim() || null,
    testName: normalizeWhitespace(issue.testName ?? "") || null,
    message: normalizeMessage(issue.message),
  };
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}

export function sanitizeText(value: string): string {
  const noAnsi = value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"), "");
  const noControls = Array.from(noAnsi)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\n" || character === "\r" || character === "\t" || (code >= 32 && code !== 127);
    })
    .join("");
  return redactSecrets(noControls).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/\bgh[pousr]_[a-z0-9]{20,}\b/gi, "[REDACTED]")
    .replace(/\beyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b((?:api[-_ ]?key|token|secret|password)\s*(?:=|:)\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(token\s+)(?!\[REDACTED\])(?:sk-)?[a-z0-9_-]{12,}\b/gi, "$1[REDACTED]");
}

export function normalizePath(value: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  let normalized = sanitizeText(value).replace(/^file:\/\//i, "").replaceAll("\\", "/");
  normalized = normalized.replace(/\/{2,}/g, "/");
  normalized = normalized.replace(/^(?:(?:[a-z]:)?\/Users\/[^/]+\/AppData\/Local\/Temp|\/(?:var\/)?tmp)\/[^/]+\//i, "");
  const lower = normalized.toLowerCase();
  for (const anchor of ["packages", "apps"]) {
    const marker = `/${anchor}/`;
    const index = lower.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
    if (lower.startsWith(`${anchor}/`)) return normalized;
  }
  for (const anchor of repositoryAnchors) {
    const marker = `/${anchor.toLowerCase()}/`;
    const index = lower.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
    if (lower.startsWith(`${anchor.toLowerCase()}/`)) return normalized;
  }
  if (/^(?:[a-z]:)?\/.*\/(?:temp|tmp)\//i.test(normalized)) {
    return `<temp>/${normalized.split("/").at(-1) ?? "output"}`;
  }
  return normalized.replace(/^[a-z]:/i, "").replace(/^\/+/, "");
}

export function normalizeMessage(value: string): string {
  let normalized = sanitizeText(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\bpid\s*[:=]?\s*\d+\b/gi, "pid <id>")
    .replace(/\b((?:request|run|trace|correlation)(?:\s+id)?)\s*[:=]?\s*[a-z0-9_-]{12,}\b/gi, "$1 <id>")
    .replace(/\b[0-9a-f]{32,}\b/gi, "<hash>")
    .replace(/\b(?:line\s*)\d+\b/gi, "line <position>")
    .replace(/\b(?:column|col)\s*\d+\b/gi, "column <position>")
    .replace(/:\d+(?::\d+)?\b/g, ":<position>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|seconds?|secs?)\b/gi, "<duration>");
  if (/\b(?:expected|received|actual)\b/i.test(normalized)) {
    normalized = normalized
      .replace(/(["']).*?\1/g, "<value>")
      .replace(/\b-?\d+(?:\.\d+)?\b/g, "<value>");
  }
  normalized = normalized.replace(/(?:[a-z]:)?[\\/](?:[^\s():]+[\\/])+[^\s():]+/gi, (path) => normalizePath(path) ?? "<path>");
  return normalizeWhitespace(normalized);
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function inferValidator(issue: ValidationIssue): ValidatorName {
  if (issue.category.startsWith("TEST_")) return "test";
  if (issue.category === "TYPE_ERROR" || issue.category === "SYNTAX_ERROR") return "typecheck";
  if (issue.category === "LINT_ERROR") return "lint";
  return "build";
}

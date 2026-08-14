import type { JsonValue } from "../domain/error.js";

const commonSecretPatterns = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(Bearer\s+)[^\s"',;]+/gi,
  /\b(api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s,"'}]+/gi,
] as const;

export function redactText(text: string, sensitiveValues: readonly string[] = []): string {
  let redacted = text;
  for (const value of [...new Set(sensitiveValues)].filter((candidate) => candidate.length > 0).sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  redacted = redacted.replace(commonSecretPatterns[0], "[REDACTED]");
  redacted = redacted.replace(commonSecretPatterns[1], "$1[REDACTED]");
  redacted = redacted.replace(commonSecretPatterns[2], "$1=[REDACTED]");
  return redacted;
}

export function createRedactor(sensitiveValues: readonly string[] = []): (value: JsonValue) => JsonValue {
  const redact = (value: JsonValue): JsonValue => {
    if (typeof value === "string") return redactText(value, sensitiveValues);
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redact(nested)]));
    }
    return value;
  };
  return redact;
}

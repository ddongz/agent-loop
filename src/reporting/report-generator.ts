import type { JsonValue } from "../domain/error.js";
import type { TaskEvent, TaskState } from "../domain/task.js";
import { createRedactor, redactText } from "../credentials/redaction.js";

export interface ReportOptions {
  sensitiveValues?: readonly string[];
}

export function generateReport(task: TaskState, events: readonly TaskEvent[], options: ReportOptions = {}): string {
  const sensitiveValues = options.sensitiveValues ?? [];
  const redact = createRedactor(sensitiveValues);
  const safeTask = redact(asJson(task)) as Record<string, JsonValue>;
  const safeEvents = events.map((event) => redact(asJson(event)) as Record<string, JsonValue>);
  const phaseEvents = safeEvents.filter((event) => ["TASK_CREATED", "PHASE_CHANGED", "TASK_PAUSED", "TASK_RESUMED", "TASK_SUCCEEDED", "TASK_FAILED"].includes(String(event.type)));
  const actionEvents = safeEvents.filter((event) => ["ACTION_REQUESTED", "ACTION_COMPLETED"].includes(String(event.type)));
  const policyEvents = safeEvents.filter((event) => event.type === "POLICY_DECIDED");
  const feedbackEvents = safeEvents.filter((event) => event.type === "FEEDBACK_CREATED");
  const approvalEvents = safeEvents.filter((event) => ["APPROVAL_REQUESTED", "APPROVAL_RESOLVED"].includes(String(event.type)));
  const budget = safeTask.budget as Record<string, JsonValue>;
  const usage = safeTask.usage as Record<string, JsonValue>;
  const protectedTests = safeTask.protectedTests as JsonValue[];

  const lines = [
    "# SentinelLoop Task Report",
    "",
    `- Task: ${inline(safeTask.id)}`,
    `- Phase: ${inline(safeTask.phase)}`,
    `- Repository: ${inline(safeTask.repositoryRoot)}`,
    `- Created: ${inline(safeTask.createdAt)}`,
    `- Updated: ${inline(safeTask.updatedAt)}`,
    "",
    "## Requirement",
    "",
    redactText(String(safeTask.requirement), sensitiveValues),
    "",
    "## Budget",
    "",
    "| Metric | Used | Limit |",
    "| --- | ---: | ---: |",
    `| Iterations | ${inline(usage.iterations)} | ${inline(budget.maxIterations)} |`,
    `| Duration (ms) | ${inline(usage.elapsedMs)} | ${inline(budget.maxDurationMs)} |`,
    `| Tokens | ${Number(usage.inputTokens) + Number(usage.outputTokens)} | ${inline(budget.maxTokens)} |`,
    `| Cost (USD) | ${inline(usage.costUsd)} | ${inline(budget.maxCostUsd)} |`,
    "",
    "## Baseline Hashes",
    "",
    ...(protectedTests.length === 0 ? ["None."] : protectedTests.map((entry) => {
      const test = entry as Record<string, JsonValue>;
      return `- ${inline(test.path)}: \`${inline(test.sha256)}\``;
    })),
    "",
    eventSection("Phase History", phaseEvents),
    eventSection("Actions", actionEvents),
    eventSection("Policy Decisions", policyEvents),
    eventSection("Feedback", feedbackEvents),
    eventSection("Approvals", approvalEvents),
    "## Final Validation",
    "",
    safeTask.finalValidation === null ? "Not available." : fenced(safeTask.finalValidation),
    "",
    "## Event Details",
    "",
    ...(safeEvents.length === 0 ? ["None."] : safeEvents.map(formatEvent)),
    "",
  ];

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function eventSection(title: string, events: readonly Record<string, JsonValue>[]): string {
  const body = events.length === 0 ? "None." : events.map(formatEvent).join("\n");
  return `## ${title}\n\n${body}\n`;
}

function formatEvent(event: Record<string, JsonValue>): string {
  return `- ${inline(event.sequence)}. ${inline(event.timestamp)} — **${inline(event.type)}** ${fenced(event.payload)}`;
}

function fenced(value: JsonValue): string {
  return `\`${JSON.stringify(value)}\``;
}

function inline(value: JsonValue | undefined): string {
  if (value === null || value === undefined) return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

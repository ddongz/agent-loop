import { createHash } from "node:crypto";

import type { Action } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import { normalizeWorkspaceRelativePath } from "./path-policy.js";

export type ApprovalFailureReason =
  | "APPROVAL_MISSING"
  | "APPROVAL_NOT_GRANTED"
  | "APPROVAL_ARGUMENT_MISMATCH"
  | "APPROVAL_BASELINE_STALE"
  | "APPROVAL_REJECTED"
  | "APPROVAL_REPLAYED";

export type ApprovalConsumption =
  | { ok: true; reasonCode: "ONE_TIME_APPROVAL_CONSUMED" }
  | { ok: false; reasonCode: ApprovalFailureReason };

export type ApprovalCheck =
  | { ok: true; reasonCode: "ONE_TIME_APPROVAL_GRANTED" }
  | { ok: false; reasonCode: ApprovalFailureReason };

export interface ApprovalRecord {
  actionId: string;
  fingerprint: string;
  baselineVersion: number;
  requestedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  consumedAt: string | null;
}

export class ApprovalManager {
  readonly #records = new Map<string, ApprovalRecord>();
  readonly #now: () => string;

  constructor(now: () => string = () => new Date().toISOString()) {
    this.#now = now;
  }

  fingerprint(action: Action, baselineVersion: number): string {
    const payload = {
      actionId: action.id,
      arguments: actionArguments(action),
      baselineVersion,
    };
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
  }

  request(action: Action, baselineVersion: number): Readonly<ApprovalRecord> {
    if (this.#records.has(action.id)) {
      throw new SentinelError({ code: "INVALID_INPUT", message: `Approval already exists for action ${action.id}.` });
    }
    assertBaselineVersion(baselineVersion);
    const requestedAt = this.#now();
    assertTimestamp(requestedAt, "Approval request");
    const record: ApprovalRecord = {
      actionId: action.id,
      fingerprint: this.fingerprint(action, baselineVersion),
      baselineVersion,
      requestedAt,
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      consumedAt: null,
    };
    this.#records.set(action.id, record);
    return { ...record };
  }

  approve(actionId: string): Readonly<ApprovalRecord> {
    const record = this.#records.get(actionId);
    if (record === undefined) {
      throw new SentinelError({ code: "INVALID_INPUT", message: `No approval request exists for action ${actionId}.` });
    }
    assertPending(record, "approve");
    record.approvedAt = this.#timestampAfter(record.requestedAt, "Approval");
    return { ...record };
  }

  reject(actionId: string, reason: string): Readonly<ApprovalRecord> {
    const record = this.#records.get(actionId);
    if (record === undefined) {
      throw new SentinelError({ code: "INVALID_INPUT", message: `No approval request exists for action ${actionId}.` });
    }
    assertPending(record, "reject");
    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0 || normalizedReason.length > 2_000) {
      throw new SentinelError({ code: "INVALID_INPUT", message: "Approval rejection reason must contain 1..2000 characters." });
    }
    record.rejectedAt = this.#timestampAfter(record.requestedAt, "Approval rejection");
    record.rejectionReason = normalizedReason;
    return { ...record };
  }

  check(action: Action, baselineVersion: number): ApprovalCheck {
    const record = this.#records.get(action.id);
    if (record === undefined) return { ok: false, reasonCode: "APPROVAL_MISSING" };
    if (record.rejectedAt !== null) return { ok: false, reasonCode: "APPROVAL_REJECTED" };
    if (record.consumedAt !== null) return { ok: false, reasonCode: "APPROVAL_REPLAYED" };
    if (record.baselineVersion !== baselineVersion) return { ok: false, reasonCode: "APPROVAL_BASELINE_STALE" };
    if (record.fingerprint !== this.fingerprint(action, baselineVersion)) {
      return { ok: false, reasonCode: "APPROVAL_ARGUMENT_MISMATCH" };
    }
    if (record.approvedAt === null) return { ok: false, reasonCode: "APPROVAL_NOT_GRANTED" };
    return { ok: true, reasonCode: "ONE_TIME_APPROVAL_GRANTED" };
  }

  consume(action: Action, baselineVersion: number): ApprovalConsumption {
    const checked = this.check(action, baselineVersion);
    if (!checked.ok) return checked;
    const record = this.#records.get(action.id);
    if (record === undefined || record.approvedAt === null) {
      throw new SentinelError({ code: "INTERNAL", message: "Approved action disappeared before consumption." });
    }
    record.consumedAt = this.#timestampAfter(record.approvedAt, "Approval consumption");
    return { ok: true, reasonCode: "ONE_TIME_APPROVAL_CONSUMED" };
  }

  #timestampAfter(previous: string, label: string): string {
    const timestamp = this.#now();
    assertTimestamp(timestamp, label);
    if (Date.parse(timestamp) <= Date.parse(previous)) {
      throw new SentinelError({ code: "INVALID_INPUT", message: `${label} timestamp must be strictly later than the preceding approval event.` });
    }
    return timestamp;
  }
}

function assertPending(record: ApprovalRecord, operation: string): void {
  if (record.approvedAt !== null || record.rejectedAt !== null || record.consumedAt !== null) {
    throw new SentinelError({
      code: "INVALID_INPUT",
      message: `Cannot ${operation} an approval request that has already been resolved.`,
    });
  }
}

function actionArguments(action: Action): Record<string, unknown> {
  const arguments_ = Object.fromEntries(
    Object.entries(action).filter(([key]) => key !== "version" && key !== "id" && key !== "rationale"),
  );
  if ("path" in arguments_ && typeof arguments_.path === "string") {
    const normalizedPath = normalizeWorkspaceRelativePath(arguments_.path);
    return {
      ...arguments_,
      path: process.platform === "win32" ? normalizedPath.toLocaleLowerCase("en-US") : normalizedPath,
    };
  }
  return arguments_;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertBaselineVersion(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SentinelError({ code: "INVALID_INPUT", message: "Approval baseline version must be a non-negative integer." });
  }
}

function assertTimestamp(value: string, label: string): void {
  const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!instantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new SentinelError({ code: "INVALID_INPUT", message: `${label} timestamp must be an ISO-8601 instant.` });
  }
}

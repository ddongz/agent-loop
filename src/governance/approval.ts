import { createHash } from "node:crypto";

import type { Action } from "../domain/action.js";
import { SentinelError } from "../domain/error.js";
import { normalizeWorkspaceRelativePath } from "./path-policy.js";

export type ApprovalFailureReason =
  | "APPROVAL_MISSING"
  | "APPROVAL_NOT_GRANTED"
  | "APPROVAL_ARGUMENT_MISMATCH"
  | "APPROVAL_BASELINE_STALE"
  | "APPROVAL_REPLAYED";

export type ApprovalConsumption =
  | { ok: true; reasonCode: "ONE_TIME_APPROVAL_CONSUMED" }
  | { ok: false; reasonCode: ApprovalFailureReason };

export interface ApprovalRecord {
  actionId: string;
  fingerprint: string;
  baselineVersion: number;
  requestedAt: string;
  approvedAt: string | null;
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
    const record: ApprovalRecord = {
      actionId: action.id,
      fingerprint: this.fingerprint(action, baselineVersion),
      baselineVersion,
      requestedAt: this.#now(),
      approvedAt: null,
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
    if (record.approvedAt === null) record.approvedAt = this.#now();
    return { ...record };
  }

  consume(action: Action, baselineVersion: number): ApprovalConsumption {
    const record = this.#records.get(action.id);
    if (record === undefined) return { ok: false, reasonCode: "APPROVAL_MISSING" };
    if (record.consumedAt !== null) return { ok: false, reasonCode: "APPROVAL_REPLAYED" };
    if (record.baselineVersion !== baselineVersion) return { ok: false, reasonCode: "APPROVAL_BASELINE_STALE" };
    if (record.fingerprint !== this.fingerprint(action, baselineVersion)) {
      return { ok: false, reasonCode: "APPROVAL_ARGUMENT_MISMATCH" };
    }
    if (record.approvedAt === null) return { ok: false, reasonCode: "APPROVAL_NOT_GRANTED" };
    record.consumedAt = this.#now();
    return { ok: true, reasonCode: "ONE_TIME_APPROVAL_CONSUMED" };
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

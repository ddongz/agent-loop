# SentinelLoop Validated Design

Date: 2026-08-14  
Status: approved by the user

## Summary

SentinelLoop is a local-first CLI coding-agent harness for adding features to clean TypeScript/Node.js Git repositories. Its primary contribution is a deterministic feedback loop that classifies validation failures, measures progress across iterations, detects stalls and oscillation, and controls termination independently of the LLM.

## Product flow

```text
PRECHECK → ANALYZE_REQUIREMENT → GENERATE_TESTS → CONFIRM_RED
→ FREEZE_TESTS → IMPLEMENT → VALIDATE
  ├─ pass → SUCCEEDED
  ├─ repairable → FEEDBACK → IMPLEMENT
  ├─ approval required → AWAITING_APPROVAL
  └─ stalled/budget/error → PAUSED or FAILED
```

The LLM can request structured actions but cannot change phases or declare success. Before implementation, the agent may only inspect the repository and modify tests. A valid red test is shown to the user and frozen with path, SHA-256, and diff. Protected tests cannot be changed without one-time approval.

## Architecture

- CLI application service;
- explicit task state machine and orchestrator;
- injectable `LLMClient` with scripted mock and OpenAI-compatible adapter;
- versioned action parser;
- policy engine and approval manager;
- structured file/search/validation tools and dispatcher;
- validation parsers, failure classifier, fingerprinting and progress detector;
- JSON/JSONL task store, memory selector, audit log and report generator;
- OS credential manager and schema-validated configuration.

## Feedback contribution

Validation runs in `test → typecheck → lint → build` order with short-circuiting. Results are normalized into deterministic issues and fingerprints. Progress considers resolved/new fingerprints, severity, earliest failing stage and effective workspace diff. Three unchanged iterations, length-2/3 oscillation, repeated action/observation, eight implementation iterations, or exhausted time/token/cost budget pauses the task.

A scripted LLM proves feedback causality by returning a repair action only after it observes the expected failure fingerprint. Separate demos prove pre-dispatch governance blocking and deterministic stall detection.

## Security and delivery

The harness exposes no general shell tool. Paths are normalized and constrained to the workspace; test baselines and sensitive paths are protected. API keys live in the OS credential manager and are redacted from logs and reports. The product is distributed as an npm package and GitHub Release for Node.js 22+ on Windows, macOS and Linux.

The course's original WebUI requirement is superseded by a later teaching-assistant clarification accepted by the user: a Release link is sufficient. This deviation is recorded in the project evidence.

## Canonical specification

The complete functional, non-functional, data, acceptance, testing, risk and mechanism design is maintained in the repository root `SPEC.md`.

# SentinelLoop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a distributable CLI coding-agent harness that adds features to clean TypeScript repositories through an explicit TDD state machine and a deterministic validation-feedback loop.

**Architecture:** A dependency-injected `TaskOrchestrator` owns all phase transitions. Untrusted LLM actions pass through runtime schemas, policy evaluation, and a structured tool dispatcher before execution; validation output is normalized into fingerprints and progress decisions that control continuation or pause. JSON/JSONL persistence enables recovery, while real LLM and OS credential adapters remain replaceable by deterministic test doubles.

**Tech Stack:** TypeScript 7, Node.js >=22.12.0, ESM, Commander 15, Zod 4, Vitest 4, OpenAI JavaScript SDK 6, Node built-ins, npm packaging, GitHub Actions and GitLab CI.

## Global Constraints

- Target repositories are clean TypeScript/Node.js Git repositories only.
- Support npm, pnpm and yarn by lockfile discovery; conflicting lockfiles are an error.
- The LLM is never given a general-purpose shell tool.
- Production code is read-only before a valid red test is accepted.
- Frozen test files cannot change without exact one-time approval.
- Validation order defaults to test → typecheck → lint → build and short-circuits on failure.
- Three unchanged failure sets, a length-2/3 oscillation, eight implementation iterations, or exhausted budget pauses the task.
- Core tests must be deterministic, offline, and require neither a real LLM nor an API key.
- Credentials use the operating-system credential manager and never fall back to plaintext.
- Distribution is an npm package named `sentinelloop-cli`; the executable is `sentinelloop`.
- The project is CLI-only; a GitHub Release link replaces WebUI under the teaching assistant's later clarification.
- Every task follows red → green → refactor and receives spec-compliance review before code-quality review.

## Locked File Map

```text
src/
  domain/{task,action,validation,error}.ts
  state/{transition-table,task-store,event-store}.ts
  repository/{workspace,package-manager,validation-discovery}.ts
  governance/{path-policy,test-baseline,policy-engine,approval}.ts
  tools/{types,registry,file-tools,validation-tool}.ts
  feedback/{parsers,fingerprint,progress,feedback-engine}.ts
  llm/{types,scripted-client,openai-compatible,context-builder}.ts
  orchestrator/task-orchestrator.ts
  config/{schema,config-store}.ts
  credentials/{types,memory-store,platform-store,redaction}.ts
  reporting/report-generator.ts
  cli/{program,io,exit-codes}.ts
  index.ts
tests/
  unit/**
  integration/**
  fixtures/validation/**
  helpers/{temp-repository,fakes}.ts
scripts/mechanism-demo.ts
```

---

### Task 1: Package foundation and domain contracts

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`
- Create: `src/domain/task.ts`, `src/domain/action.ts`, `src/domain/validation.ts`, `src/domain/error.ts`
- Create: `tests/unit/domain/contracts.test.ts`

**Interfaces:**
- Produces: `TaskPhase`, `TaskState`, `Budget`, `Action`, `Observation`, `ValidationResult`, `ValidationIssue`, `Feedback`, `SentinelError`.
- Consumes: no implementation interfaces.

- [ ] **Step 1: Add package/tooling manifests without source implementation**

Use ESM, `engines.node: ">=22.12.0"`, bin `sentinelloop: dist/index.js`, scripts `build`, `test`, `typecheck`, `lint`, `check`, and dependencies `commander`, `openai`, `zod`; dev dependencies include TypeScript, Vitest, ESLint and types.

- [ ] **Step 2: Write failing schema contract tests**

```ts
import { describe, expect, it } from "vitest";
import { ActionSchema } from "../../../src/domain/action.js";
import { TaskStateSchema } from "../../../src/domain/task.js";

it("rejects an unknown action", () => {
  expect(ActionSchema.safeParse({ version: 1, id: "a1", type: "shell", command: "rm -rf /" }).success).toBe(false);
});

it("rejects success without final validation", () => {
  expect(() => TaskStateSchema.parse({ id: "t1", phase: "SUCCEEDED", finalValidationAt: null })).toThrow();
});
```

- [ ] **Step 3: Run the focused test and record the red result**

Run: `npm test -- tests/unit/domain/contracts.test.ts`  
Expected: FAIL because domain modules do not exist.

- [ ] **Step 4: Implement strict Zod schemas and inferred types**

Define discriminated action types for `read_file`, `list_files`, `search_files`, `create_file`, `apply_patch`, `run_validation`, `finish`, and `request_clarification`; define task phases and validation issue categories exactly as specified in `SPEC.md`.

- [ ] **Step 5: Run domain tests, typecheck and lint**

Run: `npm test -- tests/unit/domain/contracts.test.ts && npm run typecheck && npm run lint`  
Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts eslint.config.js src/domain tests/unit/domain
git commit -m "feat(domain): define harness contracts"
```

### Task 2: Explicit transition table and durable task store

**Files:**
- Create: `src/state/transition-table.ts`, `src/state/task-store.ts`, `src/state/event-store.ts`
- Create: `tests/unit/state/transition-table.test.ts`, `tests/integration/state/task-store.test.ts`

**Interfaces:**
- Consumes: `TaskPhase`, `TaskState` and Zod schemas from Task 1.
- Produces: `canTransition(from: TaskPhase, to: TaskPhase): boolean`; `TaskStore.create/load/save`; `EventStore.append/list`.

- [ ] **Step 1: Write failing transition tests**

```ts
expect(canTransition("PRECHECK", "ANALYZE_REQUIREMENT")).toBe(true);
expect(canTransition("GENERATE_TESTS", "IMPLEMENT")).toBe(false);
expect(canTransition("VALIDATE", "SUCCEEDED")).toBe(true);
```

- [ ] **Step 2: Run and confirm the missing implementation failure**

Run: `npm test -- tests/unit/state/transition-table.test.ts`  
Expected: FAIL with unresolved module.

- [ ] **Step 3: Implement a total, explicit transition table**

Include all phases from the specification and export `transition(state, next, now)` that rejects illegal transitions with `INVALID_TRANSITION`.

- [ ] **Step 4: Write failing atomic persistence/recovery tests**

Create a temporary `.sentinelloop/tasks/t1`, save a state and two events, instantiate new stores, then assert schema-validated recovery and monotonic event sequence.

- [ ] **Step 5: Implement atomic JSON state and append-only JSONL events**

Write state through a same-directory temporary file and rename; fsync before rename where supported. Reject corrupted state rather than guessing defaults.

- [ ] **Step 6: Run focused and full checks**

Run: `npm test -- tests/unit/state tests/integration/state && npm run typecheck`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/state tests/unit/state tests/integration/state
git commit -m "feat(state): add explicit transitions and recovery"
```

### Task 3: Repository precheck and validation discovery

**Files:**
- Create: `src/repository/workspace.ts`, `src/repository/package-manager.ts`, `src/repository/validation-discovery.ts`
- Create: `tests/helpers/temp-repository.ts`
- Create: `tests/integration/repository/precheck.test.ts`, `tests/unit/repository/discovery.test.ts`

**Interfaces:**
- Produces: `precheckRepository(root): Promise<RepositoryProfile>`; `discoverPackageManager(files): PackageManager`; `discoverValidationPlan(packageJson, overrides): ValidationPlan`.
- Consumes: domain errors from Task 1.

- [ ] **Step 1: Write failing dirty-worktree and lockfile tests**

```ts
await expect(precheckRepository(dirtyRepo)).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
expect(() => discoverPackageManager(["package-lock.json", "pnpm-lock.yaml"])).toThrowError(/conflicting/i);
```

- [ ] **Step 2: Run the tests and capture red**

Run: `npm test -- tests/integration/repository/precheck.test.ts tests/unit/repository/discovery.test.ts`  
Expected: FAIL because repository services do not exist.

- [ ] **Step 3: Implement realpath, Git and Node prechecks**

Use `git status --porcelain`, verify `.git`, parse `process.versions.node`, require >=22.12.0, and ensure `package.json` exists. Do not create `.sentinelloop` until all checks pass.

- [ ] **Step 4: Implement lockfile and script discovery**

Map package manager commands without invoking the LLM. Discover scripts named `test`, `typecheck`, `lint`, `build`; require `test`; apply schema-validated user overrides.

- [ ] **Step 5: Run repository tests and full static checks**

Run: `npm test -- tests/integration/repository tests/unit/repository && npm run typecheck && npm run lint`  
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repository tests/helpers tests/integration/repository tests/unit/repository
git commit -m "feat(repository): enforce clean repository precheck"
```

### Task 4: Governance, path confinement and frozen tests

**Files:**
- Create: `src/governance/path-policy.ts`, `src/governance/test-baseline.ts`, `src/governance/policy-engine.ts`, `src/governance/approval.ts`
- Create: `tests/unit/governance/path-policy.test.ts`, `tests/unit/governance/test-baseline.test.ts`, `tests/unit/governance/policy-engine.test.ts`

**Interfaces:**
- Produces: `resolveWorkspacePath(root, relative): Promise<string>`; `TestBaseline.freeze/verify`; `PolicyEngine.evaluate(context, action): Promise<PolicyDecision>` where decision is `ALLOW | DENY | REQUIRE_APPROVAL`.
- Consumes: `Action`, `TaskPhase`, domain errors.

- [ ] **Step 1: Write failing escape and phase-policy tests**

```ts
await expect(resolveWorkspacePath(root, "../secret.txt")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
expect(await policy.evaluate({ phase: "GENERATE_TESTS" }, productionWrite)).toEqual(expect.objectContaining({ kind: "DENY" }));
```

- [ ] **Step 2: Write failing frozen-baseline tests**

Freeze `tests/feature.test.ts`, change its content, and assert `verify()` returns a mismatch; assert a write action against it yields `REQUIRE_APPROVAL` before any tool is called.

- [ ] **Step 3: Run governance tests and capture red**

Run: `npm test -- tests/unit/governance`  
Expected: FAIL with missing modules.

- [ ] **Step 4: Implement path/symlink confinement and SHA-256 baselines**

Resolve the nearest existing ancestor with `realpath`, reconstruct the target, verify it remains below root, and repeat immediately before writes. Store normalized relative paths, hashes, diff and confirmation metadata.

- [ ] **Step 5: Implement phase permissions and exact one-time approval records**

Before `FREEZE_TESTS`, only test-pattern writes are allowed; afterward protected tests require approval. Unknown tools and sensitive paths are denied. Approval binds action ID, normalized arguments and baseline version.

- [ ] **Step 6: Run governance and type checks**

Run: `npm test -- tests/unit/governance && npm run typecheck`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/governance tests/unit/governance
git commit -m "feat(governance): confine actions and freeze tests"
```

### Task 5: Structured tool registry and safe file tools

**Files:**
- Create: `src/tools/types.ts`, `src/tools/registry.ts`, `src/tools/file-tools.ts`, `src/tools/validation-tool.ts`
- Create: `tests/unit/tools/registry.test.ts`, `tests/integration/tools/file-tools.test.ts`, `tests/integration/tools/validation-tool.test.ts`

**Interfaces:**
- Produces: `Tool<I>.execute(input, signal): Promise<Observation>`; `ToolRegistry.dispatch(context, action): Promise<Observation>`.
- Consumes: action schemas and `PolicyEngine`; `ValidationPlan` from Task 3.

- [ ] **Step 1: Write failing pre-dispatch policy test**

Use a spy tool and a denied action; assert `execute` was never called and the observation code is `POLICY_DENIED`.

- [ ] **Step 2: Write failing atomic patch, output limit and timeout tests**

Assert a conflicting patch leaves the file unchanged; output over 64 KiB is truncated with metadata; an expired AbortSignal kills validation and returns `TIMEOUT`.

- [ ] **Step 3: Run tool tests to verify red**

Run: `npm test -- tests/unit/tools tests/integration/tools`  
Expected: FAIL with missing registry/tools.

- [ ] **Step 4: Implement registry and read/list/search/create/apply-patch tools**

Every tool has a Zod input schema. Use Node APIs for file operations and a small internal unified-diff applicator limited to exact-context hunks; do not invoke shell editors.

- [ ] **Step 5: Implement validation process runner**

Use `spawn` with `shell: false`, package-manager executable plus argument array, bounded buffers, timeout/abort, and a process-tree termination strategy per platform.

- [ ] **Step 6: Run focused tests and static checks**

Run: `npm test -- tests/unit/tools tests/integration/tools && npm run typecheck && npm run lint`  
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/tools tests/unit/tools tests/integration/tools
git commit -m "feat(tools): add governed structured tool dispatch"
```

### Task 6: Validation parsers and deterministic feedback engine

**Files:**
- Create: `src/feedback/parsers.ts`, `src/feedback/fingerprint.ts`, `src/feedback/progress.ts`, `src/feedback/feedback-engine.ts`
- Create: `tests/fixtures/validation/{vitest-fail.txt,jest-fail.txt,tsc-fail.txt,eslint-fail.txt,build-fail.txt}`
- Create: `tests/unit/feedback/parsers.test.ts`, `tests/unit/feedback/fingerprint.test.ts`, `tests/unit/feedback/progress.test.ts`, `tests/unit/feedback/feedback-engine.test.ts`

**Interfaces:**
- Produces: `parseValidation(raw): ValidationResult`; `fingerprint(issue): string`; `detectProgress(history): Progress`; `FeedbackEngine.evaluate(results, history, diff): FeedbackDecision`.
- Consumes: validation domain types from Task 1.

- [ ] **Step 1: Add realistic fixed output fixtures and failing parser tests**

```ts
expect(parseValidation(vitestFixture).issues[0]).toMatchObject({ category: "TEST_ASSERTION", testName: "returns user by email" });
expect(parseValidation(tscFixture).issues[0]).toMatchObject({ category: "TYPE_ERROR", rule: "TS2322" });
```

- [ ] **Step 2: Run parser tests and record red**

Run: `npm test -- tests/unit/feedback/parsers.test.ts`  
Expected: FAIL because parser module does not exist.

- [ ] **Step 3: Implement ordered parsers with UNKNOWN fallback**

Prefer structured reporter JSON when available; otherwise parse stable Vitest/Jest/tsc/ESLint patterns. Preserve only redacted, bounded summaries on fallback.

- [ ] **Step 4: Write failing fingerprint normalization tests**

Two issues differing only in line number, duration, temp root and actual value must share a fingerprint; different test names or TS codes must not.

- [ ] **Step 5: Implement fingerprinting and progress comparison**

Return `improved`, `unchanged`, `regressed`, or `oscillating`; stage advancement outranks raw issue count. Detect length-2 and length-3 cycles.

- [ ] **Step 6: Write and satisfy feedback/stall tests**

Assert compact feedback includes resolved/new/repeated fingerprints and budgets; assert three unchanged sets yield `PAUSE_NO_PROGRESS`, while all enabled validators passing yields `REQUEST_SUCCESS_CHECK`.

- [ ] **Step 7: Run feedback suite and full static checks**

Run: `npm test -- tests/unit/feedback && npm run typecheck && npm run lint`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/feedback tests/fixtures/validation tests/unit/feedback
git commit -m "feat(feedback): classify failures and detect progress"
```

### Task 7: LLM abstraction, scripted mock and context builder

**Files:**
- Create: `src/llm/types.ts`, `src/llm/scripted-client.ts`, `src/llm/openai-compatible.ts`, `src/llm/context-builder.ts`
- Create: `tests/unit/llm/scripted-client.test.ts`, `tests/unit/llm/context-builder.test.ts`, `tests/unit/llm/openai-compatible.test.ts`

**Interfaces:**
- Produces: `LLMClient.complete(request): Promise<CompletionResult>`; `ScriptedLLMClient`; `OpenAICompatibleClient`; `buildContext(task, events, feedback): CompletionRequest`.
- Consumes: `Action`, `Feedback`, task/events and available tool schemas.

- [ ] **Step 1: Write failing scripted feedback-causality test**

```ts
const client = new ScriptedLLMClient([{ when: { feedbackFingerprint: "fp-1" }, action: repairAction }]);
await expect(client.complete(requestWithoutFp)).rejects.toMatchObject({ code: "SCRIPT_NO_MATCH" });
expect((await client.complete(requestWithFp)).action).toEqual(repairAction);
```

- [ ] **Step 2: Write failing context minimization/redaction tests**

Assert context contains original requirement, current phase, available tools, latest feedback and budget, but excludes old unrelated events and a seeded secret.

- [ ] **Step 3: Run LLM tests and record red**

Run: `npm test -- tests/unit/llm`  
Expected: FAIL with missing modules.

- [ ] **Step 4: Implement interfaces, scripted matcher and context builder**

The scripted client must branch on request content, not merely dequeue responses. Context builder caps sections and emits no full unbounded logs.

- [ ] **Step 5: Implement OpenAI-compatible single-call adapter**

Configure `baseURL`, model, API key and approved extra headers. Call only Chat Completions/tool calling. Map auth, rate limit, timeout, unavailable and protocol errors to stable `SentinelError` codes.

- [ ] **Step 6: Test adapter using a fake fetch transport**

Assert correct request schema and that malformed/multiple unsupported tool calls are rejected without reaching the dispatcher.

- [ ] **Step 7: Run LLM suite and checks**

Run: `npm test -- tests/unit/llm && npm run typecheck && npm run lint`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/llm tests/unit/llm
git commit -m "feat(llm): add injectable compatible client"
```

### Task 8: End-to-end task orchestrator and red-test gate

**Files:**
- Create: `src/orchestrator/task-orchestrator.ts`
- Create: `tests/helpers/fakes.ts`
- Create: `tests/integration/orchestrator/red-gate.test.ts`, `tests/integration/orchestrator/feedback-loop.test.ts`, `tests/integration/orchestrator/pause-resume.test.ts`

**Interfaces:**
- Produces: `TaskOrchestrator.start(input): Promise<TaskState>`; `step(taskId): Promise<TaskState>`; `resume(taskId, approval?): Promise<TaskState>`.
- Consumes: all interfaces from Tasks 2–7 through constructor injection.

- [ ] **Step 1: Write failing phase-gate integration test**

Script an LLM that attempts production write during `GENERATE_TESTS`; assert denial, no file change and phase remains test generation. Then script test creation and invalid syntax failure; assert it cannot freeze.

- [ ] **Step 2: Run red-gate test and record red**

Run: `npm test -- tests/integration/orchestrator/red-gate.test.ts`  
Expected: FAIL because orchestrator does not exist.

- [ ] **Step 3: Implement orchestration through FREEZE_TESTS**

Make every phase transition explicit, persist before/after external effects, validate red-test eligibility, and use injected confirmation IO to freeze the baseline.

- [ ] **Step 4: Write failing feedback-causality success test**

Script wrong implementation → deterministic assertion fingerprint → repair only when fingerprint is in context → validators pass → final baseline verification → SUCCEEDED.

- [ ] **Step 5: Implement implementation/validation loop and success gate**

`finish` triggers validation only. Require all enabled validators after last write, no pending approval, allowed diff and unchanged baseline.

- [ ] **Step 6: Write failing no-progress, oscillation and recovery tests**

Assert three unchanged sets and a two-state cycle pause; reload a new orchestrator instance from disk and resume without losing iteration/budget/event sequence.

- [ ] **Step 7: Implement deterministic pause/resume and interruption handling**

Persist pause reason and exact pending action; re-run repository and baseline checks before resuming.

- [ ] **Step 8: Run orchestrator tests and full checks**

Run: `npm test -- tests/integration/orchestrator && npm run check`  
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/orchestrator tests/helpers/fakes.ts tests/integration/orchestrator
git commit -m "feat(orchestrator): enforce deterministic TDD loop"
```

### Task 9: Configuration, OS credentials, CLI and reports

**Files:**
- Create: `src/config/schema.ts`, `src/config/config-store.ts`
- Create: `src/credentials/types.ts`, `src/credentials/memory-store.ts`, `src/credentials/platform-store.ts`, `src/credentials/redaction.ts`
- Create: `src/reporting/report-generator.ts`
- Create: `src/cli/program.ts`, `src/cli/io.ts`, `src/cli/exit-codes.ts`, `src/index.ts`
- Create: `tests/unit/config/config.test.ts`, `tests/unit/credentials/credentials.test.ts`, `tests/unit/reporting/report.test.ts`, `tests/integration/cli/cli.test.ts`

**Interfaces:**
- Produces: `CredentialStore.set/get/delete/metadata`; `ConfigStore`; `createProgram(deps)`; `generateReport(task, events): string`.
- Consumes: orchestrator APIs from Task 8.

- [ ] **Step 1: Write failing credential and redaction tests**

Assert `auth status` reports configured metadata without any key fragment; seed a secret into nested errors/events and assert report/log redaction.

- [ ] **Step 2: Write failing CLI contract tests**

Exercise `auth set/status/clear`, `run`, `resume`, `status`, `report`, exit codes and empty requirement using injected IO, memory credentials and fake orchestrator.

- [ ] **Step 3: Run focused tests and record red**

Run: `npm test -- tests/unit/config tests/unit/credentials tests/unit/reporting tests/integration/cli`  
Expected: FAIL with missing modules.

- [ ] **Step 4: Implement config and credential interfaces**

User config stores only non-secret base URL, model, allowed header names and policies. Platform adapter invokes PowerShell PasswordVault on Windows, `security` on macOS, and `secret-tool` on Linux with arguments/stdin and `shell: false`; backend absence is a hard, actionable error.

- [ ] **Step 5: Implement CLI and hidden-input IO**

Expose the specified subcommands. Never accept API key as a command option. Map success, pause, user/config, environment and internal errors to documented stable exit codes.

- [ ] **Step 6: Implement deterministic Markdown report**

Include original requirement, baseline hashes, phase history, actions, policy decisions, feedback summaries, approvals, budget and final validation; redact before serialization.

- [ ] **Step 7: Run CLI/report suite and full checks**

Run: `npm test -- tests/unit/config tests/unit/credentials tests/unit/reporting tests/integration/cli && npm run check`  
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/config src/credentials src/reporting src/cli src/index.ts tests/unit/config tests/unit/credentials tests/unit/reporting tests/integration/cli
git commit -m "feat(cli): add credentials commands and task interface"
```

### Task 10: Required mechanism demonstrations

**Files:**
- Create: `scripts/mechanism-demo.ts`
- Create: `tests/demos/governance.demo.test.ts`, `tests/demos/feedback.demo.test.ts`, `tests/demos/stall.demo.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run demo` with three deterministic named scenarios.
- Consumes: real harness components with Scripted LLM and temporary repositories.

- [ ] **Step 1: Write failing governance demo**

Assert a path escape or protected-test action produces `DENY/REQUIRE_APPROVAL`, tool spy call count remains zero, and an audit event names the rule.

- [ ] **Step 2: Write failing feedback demo**

Assert the scripted client refuses repair without expected fingerprint, receives it after injected failure, changes action, and reaches SUCCEEDED after validation.

- [ ] **Step 3: Write failing main-contribution stall demo**

Assert repeated identical failure fingerprints produce PAUSED exactly on the third unchanged implementation result and the report names `NO_PROGRESS`.

- [ ] **Step 4: Run demos to capture red**

Run: `npm test -- tests/demos`  
Expected: FAIL until scenario composition and runner exist.

- [ ] **Step 5: Implement demo composition and human-readable runner**

The runner prints scenario name, key events, final state and PASS/FAIL, exits nonzero on any mismatch, and never contacts a network.

- [ ] **Step 6: Run deterministic demos twice**

Run: `npm run demo && npm run demo`  
Expected: identical normalized output and exit code 0 both times.

- [ ] **Step 7: Commit**

```bash
git add scripts/mechanism-demo.ts tests/demos package.json
git commit -m "test(demo): prove governance feedback and stall mechanisms"
```

### Task 11: Distribution, CI and user documentation

**Files:**
- Create: `README.md`, `LICENSE`, `THIRD_PARTY_LICENSES.md`, `.npmignore`
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.gitlab-ci.yml`
- Modify: `package.json`, `TASKS.md`, `AGENT_LOG.md`
- Create: `tests/integration/distribution/package.test.ts`

**Interfaces:**
- Produces: installable npm tarball, GitHub Release workflow, GitLab `unit-test` job and complete user documentation.
- Consumes: final CLI and scripts.

- [ ] **Step 1: Write failing package smoke test**

Build and `npm pack --json`, install the tarball in a clean temporary directory with scripts disabled, run the packaged bin `--help`, and assert no source/tests/secrets are included unexpectedly.

- [ ] **Step 2: Run package test and capture red**

Run: `npm test -- tests/integration/distribution/package.test.ts`  
Expected: FAIL before package files/build output are configured.

- [ ] **Step 3: Configure build and npm contents**

Publish only `dist`, README, LICENSE and package metadata; include source maps but no `.sentinelloop`, `.env`, test fixtures or assignment-only files.

- [ ] **Step 4: Add CI definitions**

GitHub CI matrix: Windows/macOS/Linux with Node 22.12+, `npm ci`, `npm run check`, `npm run demo`, `npm pack`. GitLab must contain a job exactly named `unit-test`. Release workflow triggers on `v*` tags, validates, packs and attaches the `.tgz` to GitHub Release; npm publish remains manual unless a token is explicitly configured.

- [ ] **Step 5: Write README and license documentation**

Include overview, architecture, installation, auth lifecycle, run/resume/status/report, demo, distribution, directory layout, security boundary, supported platforms, known limitations, provider compatibility, troubleshooting and teaching-assistant WebUI clarification. List third-party licenses.

- [ ] **Step 6: Run package and all checks**

Run: `npm run check && npm run demo && npm test -- tests/integration/distribution/package.test.ts && npm pack --dry-run`  
Expected: all PASS; tarball file list is intentional.

- [ ] **Step 7: Commit**

```bash
git add README.md LICENSE THIRD_PARTY_LICENSES.md .npmignore .github .gitlab-ci.yml package.json tests/integration/distribution TASKS.md AGENT_LOG.md
git commit -m "build: add distribution CI and documentation"
```

### Task 12: Final evidence, security audit and release readiness

**Files:**
- Modify: `PLAN.md`, `TASKS.md`, `AGENT_LOG.md`, `SPEC_PROCESS.md`, `README.md`
- Create: `RELEASE_CHECKLIST.md`
- Student-only: `REFLECTION.md`

**Interfaces:**
- Produces: verified repository ready for remote push/tag and student-authored reflection.
- Consumes: all project outputs.

- [ ] **Step 1: Run the full verification suite from a clean checkout/worktree**

Run: `npm ci && npm run check && npm run demo && npm pack --dry-run`  
Expected: every command exits 0.

- [ ] **Step 2: Audit secrets and generated artifacts**

Search working tree and Git history for known test-secret markers, common key patterns, `.env`, credential values and `.sentinelloop`; document the commands and zero-real-secret result in `RELEASE_CHECKLIST.md`.

- [ ] **Step 3: Perform two-stage final review**

First verify every SPEC acceptance criterion maps to a test/evidence item. Then review correctness, security, failure handling, portability, test quality and package contents. Fix Critical findings through separate TDD cycles.

- [ ] **Step 4: Update process evidence**

Mark PLAN/TASKS items complete with commit hashes; finish cold-start and subagent records in `SPEC_PROCESS.md`/`AGENT_LOG.md`; record every workflow deviation and human modification.

- [ ] **Step 5: Prepare remote release instructions**

Document exact commands for adding GitHub/NJU Git remotes, pushing branches, creating PRs and tagging `v0.1.0`. Do not fabricate remote URLs or claim CI/Release success before external execution.

- [ ] **Step 6: Student writes reflection**

The student must personally write 1500–2500 Chinese characters in `REFLECTION.md`; AI may only polish text with disclosure. Verify presence and length but do not generate its substantive content.

- [ ] **Step 7: Commit final local evidence**

```bash
git add PLAN.md TASKS.md AGENT_LOG.md SPEC_PROCESS.md README.md RELEASE_CHECKLIST.md REFLECTION.md
git commit -m "docs: finalize project evidence and release checklist"
```

## Dependency Graph and Parallelism

```text
Task 1 → Task 2 → Task 8 → Task 9 → Task 10 → Task 11 → Task 12
       ↘ Task 3 ↗
       ↘ Task 4 → Task 5 ↗
       ↘ Task 6 ─────────↗
       ↘ Task 7 ─────────↗
```

- Tasks 3, 4, 6 and 7 can run in parallel after Task 1, but Task 5 depends on Task 4.
- Task 8 integrates Tasks 2–7 and must follow all of them.
- Tasks 9–12 are sequential because each packages or documents the preceding deliverable.
- Each worktree/PR should group one reviewer-rejectable task, not multiple unrelated tasks.

## Plan Self-Review Record

- Spec coverage: all 15 acceptance criteria map to Tasks 1–12; six harness dimensions map to Tasks 2–9; all three required demos map to Task 10.
- Placeholder scan: no TBD/TODO/“implement later” steps; external remote URL and student reflection are explicitly authorized external/student-only gates rather than implementation placeholders.
- Type consistency: shared domain types originate in Task 1; repositories/governance/tools/feedback/LLM are injected into the Task 8 orchestrator; CLI consumes Task 8; distribution consumes the CLI.
- Scope: one CLI product with one primary feedback contribution; WebUI, arbitrary shell, multi-language and multi-agent product features remain excluded.

# Agent Log

## 2026-08-13 — Project intake and requirements analysis

- Task: PRE-01
- Skills/process: requirements reading; Superpowers availability audit
- Context: read the common and A-class assignment documents; produced a merged requirements analysis.
- Human intervention: user corrected the requested output from two analyses to one merged document.
- Evidence: `AI4SE期末项目_A类Coding_Agent_Harness_完整要求解析.md`
- Lesson: conflicting GitHub/NJU Git and WebUI wording must be explicitly reconciled rather than silently choosing one.

## 2026-08-13 — Superpowers installation

- Task: PRE-02
- Skills/process: `using-superpowers`
- Context: the assignment mandates Superpowers but it was absent from the active skills list.
- Human intervention: user approved installation of `superpowers@openai-curated-remote`.
- Evidence: installed Superpowers 6.2.0 under the Codex plugin cache.
- Lesson: process tooling is part of the submission evidence and must be established before implementation.

## 2026-08-13 to 2026-08-14 — Brainstorming and design

- Task: SPEC-01
- Skill: `brainstorming`
- Key context: A-class harness must implement six dimensions in code, with deterministic mock-LLM tests and one deep contribution.
- Decisions: TypeScript/Node.js, CLI-only, npm Release, OpenAI-compatible Chat Completions tool calling, natural-language feature tasks, agent-generated tests, frozen test baseline, structured tools, deterministic feedback main contribution.
- Human intervention: user rejected the initial CLI + WebUI recommendation because the teaching assistant later allowed a Release link instead; user also chose natural language instead of a structured task file.
- Evidence: `SPEC_PROCESS.md`, `SPEC.md`, `docs/superpowers/specs/2026-08-14-sentinelloop-design.md`.
- Lesson: a deterministic harness still needs a human boundary where natural-language intent becomes an accepted test oracle.

## Declared workflow deviation

- The original common requirements mandate an accessible WebUI, while the user reports a later teaching-assistant clarification allowing a Release link instead. The project follows the newer course clarification and remains CLI-only.
- This log is being initialized during the specification phase and will be updated per implementation task with prompts, subagents, red/green evidence, reviews and commit hashes.
- The brainstorming skill normally requests a second explicit review after writing the spec file. The user had already approved each critical design section and then explicitly instructed the agent to use recommended choices for remaining design and continue without routine pauses. That instruction is treated as authorization to transition after inline spec self-review.

## 2026-08-14 — Cold-start specification validation

- Task: SPEC-02
- Skills: `writing-plans`, `using-git-worktrees`; different-type fresh agent validation.
- Context: a `gpt-5.6-terra` agent with no forked turns received only `SPEC.md` and `PLAN.md` in `validation-cold-start`.
- Result: it correctly stopped without writing code. It found missing phase literals/transition matrix, incomplete Action/Validation/TaskState schemas, and a PLAN import contradiction.
- Human intervention: none; user had authorized recommended non-critical decisions and continuous progress.
- Revision: added authoritative literal unions, transitions, object schemas, invariants and corrected import ownership. Full before/after summary is in `SPEC_PROCESS.md` §7.
- Lesson: prose architecture can feel complete to its authors while still being unusable as an independent programming contract; cold-start validation exposed this before implementation cost was incurred.

## 2026-08-14 — Cold-start review round 2

- Task: SPEC-03
- Context: the same isolated unfamiliar agent reviewed only the revised SPEC/PLAN and did not implement.
- Result: original six blockers were resolved; deeper contract gaps remained for serialized errors, durable events, state-dependent recovery transitions and success evidence.
- Revision: defined error-code and serialization contracts, complete TaskEvent schema/recovery invariants, stateful transition APIs, and ValidationSnapshot-backed success refinements.
- Lesson: resolving surface type names is insufficient; persistence and state-machine APIs must carry enough evidence to enforce their declared invariants.

## 2026-08-14 — Cold-start final verdict

- Task: SPEC-04
- Agent verdict: PASS at specification commit `28dc209`.
- Evidence: the unfamiliar agent confirmed all 10 blockers now have directly testable authoritative definitions and still made no implementation changes.
- Decision: specification gate is open; formal implementation may start under worktree + subagent + TDD + two-stage review.

## 2026-08-14 — Task 1 dependency compatibility decision

- Task: IMPL-01 fix round 1
- Trigger: plan initially named TypeScript 7; installing 7.0.2 made `typescript-eslint@8.67.0` hard-fail because its supported peer range is `>=4.8.4 <6.1.0`.
- Investigation: TypeScript 7 typecheck passed, but lint failed before analyzing source; `npm ls` confirmed every typescript-eslint package marked TS7 invalid.
- Decision: use TypeScript 6.0.3, the newest stable line inside the supported range, rather than disabling warnings or shipping an unsupported toolchain.
- Human intervention: none; the user authorized recommended non-critical design and dependency choices.

## 2026-08-14 — Task 1 implementation and review closure

- Task: IMPL-01, package foundation and domain contracts.
- Implementer: fresh `gpt-5.6-terra` subagent using test-driven development.
- Red evidence: the focused contract test initially failed because the domain modules did not exist; the review-fix test run then exposed 5/11 and 6/11 failing invariant cases before production changes.
- Green evidence: 11/11 focused tests passed, followed by passing typecheck and lint; `npm audit` reported zero vulnerabilities.
- Review: the first review identified incomplete persisted-event/baseline schemas and several invariant edge cases. Fix round 1 addressed all Critical/Important findings. A fresh scoped re-review returned Spec Compliance PASS and Task Quality PASS, with transition behavior explicitly deferred to Task 2 by plan ownership.
- Commits: `80933cc` (initial implementation), `ca943d3` (review fixes).
- Human intervention: none.
- Lesson: schema contracts need positive fixtures and mutation-style negative cases; checking only rejection paths can make a suite pass vacuously.

## 2026-08-14 — Task 2 state machine and durable persistence

- Task: IMPL-02, explicit transition table, atomic task state, append-only events, and recovery validation.
- TDD evidence: initial missing-module REDs; review fix round 1 added 19 focused cases with 5 expected failures; round 2 added recovery/approval guards with 2 expected failures before implementation.
- Green evidence: 23/23 focused state tests and 34/34 full tests passed; typecheck, lint, build and diff-check passed.
- Review history: initial review found six Important issues. Four contract defects and related hardening were fixed in `7d92506`; cross-process multi-writer locks were ruled outside v1's explicit single-Agent/single-writer scope. First re-review found two remaining issues; `37705c1` fixed write-time recovery validation and approval context guards, strengthened write-adjacent path checks/no-follow behavior, and clarified the declared pure-Node TOCTOU residual risk.
- Final verdict: 0 Critical, 0 Important; Spec Compliance PASS and Task Quality PASS. One Minor remains: a write-boundary symlink test does not precisely distinguish the entry check from the final check, though the implementation has both.
- Commits: `8833092`, `7d92506`, `37705c1`.
- Human intervention: none.
- Lesson: a security threat table must distinguish guaranteed controls from residual OS-level races; tests and documentation should not imply stronger atomicity than the runtime can provide.

## 2026-08-14 — Task 3 repository precheck and discovery

- Task: IMPL-03, clean-Git precheck, Node boundary, package-manager detection and deterministic validation discovery.
- TDD evidence: missing-module RED; initial GREEN attempt exposed three fixture/path/order defects. Review fixes added four focused RED cases for dirty precedence, prerelease SemVer and Windows executable paths.
- Green evidence: 25/25 focused tests and 59/59 full tests passed; typecheck, lint, build and diff-check passed.
- Review: initial review found 3 Important issues; all were fixed in `4f3a0aa`. Final re-review returned 0 Critical/Important, Spec Compliance PASS and Task Quality PASS.
- Minor: clean Git repository with missing package.json has correct implementation behavior but no longer has a direct focused regression test.
- Commits: `5bf87fe`, `4f3a0aa`.
- Human intervention: none.
- Lesson: environment prechecks require an explicit error-precedence policy, and structured process arguments make whitespace heuristics both unnecessary and harmful to Windows portability.

## 2026-08-14 — Task 4 governance and frozen-test baseline

- Task: IMPL-04, path confinement, sensitive-path policy, versioned test baseline and one-time approval lifecycle.
- Initial green: 40 governance tests and 99 full tests; review found 1 Critical and 4 Important gaps.
- Fix evidence: 10 security-boundary REDs, 4 baseline REDs, approval lifecycle REDs, plus symlink-alias and complete 12x8 phase/action matrix REDs; all were turned green.
- Final green: 72 focused governance/domain tests and 120 full tests; typecheck, lint, build and diff checks passed.
- Final review: all findings addressed; 0 Critical/Important/Minor, Spec Compliance PASS and Task Quality PASS.
- Commits: `063786a`, `3f7341d`.
- Human intervention: none.
- Lesson: approval metadata is not a baseline update; an approved mutation must recapture content hashes and advance a restorable versioned artifact.

## 2026-08-14 — Task 5 governed structured tools

- Task: IMPL-05, registry, safe file/list/search/patch tools and bounded validation runner.
- Initial evidence: 30 focused and 150 full tests passed; review found 4 Important/3 Minor correctness issues.
- Fix round 1: two-phase approval consumption, original-coordinate patching, EOF/mixed-ending preservation, external signal classification, unknown identity, UTF-8 safe truncation and glob semantics; 166 full tests passed.
- Fix round 2: final encoded-byte cap for invalid UTF-8 and approval-consume exception normalization; 168 full tests passed.
- Final review: targeted 23/23 and typecheck passed; no new Critical/Important; Spec PASS and Quality PASS.
- Commits: `64ef79b`, `3912690`, `c52401b`.
- Human intervention: none.
- Lesson: an approval is a transactional capability and must only be consumed at the last safe point before a real dispatch attempt; diff correctness depends on coordinates and EOF semantics, not just matching context text.

## 2026-08-14 — Task 6 deterministic feedback loop

- Task: IMPL-06, validation parsers, stable fingerprints, multi-signal progress and deterministic feedback/stop decisions.
- Initial implementation: 33 focused and 201 full tests; review found parser completeness, validator completeness, fingerprint and progress flaws.
- Fix round 1: 20/57 targeted REDs; exact enabled-validator success, complete parser classes/TIMEOUT, bounded issues, stable temp paths and full progress signatures; 227 full tests.
- Fix round 2: separated failure-set cycle signatures from full unchanged signatures and preserved stable expected semantics while normalizing volatile actual values; 231 full tests.
- Final review: targeted 20/20 and typecheck passed; no Critical/Important; Spec PASS and Quality PASS.
- Commits: `41f232b`, `1dd40e4`, `467987e`.
- Human intervention: none.
- Lesson: oscillation and unchanged detection need different signatures; success gates must validate an exact authoritative validator set, never infer completeness from the results presented.

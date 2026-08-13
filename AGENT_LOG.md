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

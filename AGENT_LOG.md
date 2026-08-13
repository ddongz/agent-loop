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

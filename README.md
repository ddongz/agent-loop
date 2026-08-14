# SentinelLoop

SentinelLoop is a Node.js CLI and TypeScript library for a deterministic,
single-agent TDD loop over a clean TypeScript Git repository. It turns model
actions into schema-validated tool calls, enforces phase and path policy before
dispatch, freezes accepted red tests, and uses normalized validator feedback to
continue, pause, or accept a result.

## Architecture

The injected `TaskOrchestrator` owns an explicit phase state machine. Repository
precheck and command discovery run before task state is created. LLM actions
then pass through runtime schemas, the policy engine, and a structured tool
registry; no general-purpose shell tool is exposed to the model. JSON/JSONL
state supports recovery, while validation fingerprints and budgets make stop
decisions deterministic. Production adapters can be replaced by the scripted
LLM and in-memory credentials used by the offline tests and demo.

## Requirements and installation

- Node.js 22.12.0 or newer
- Windows, macOS, or Linux
- A clean TypeScript/Node.js Git repository using exactly one of npm, pnpm, or
  yarn lockfiles and exposing a test script

Install a GitHub Release tarball:

```sh
npm install -g ./sentinelloop-cli-0.1.0.tgz
sentinelloop --help
```

If the package is published to npm manually, use
`npm install -g sentinelloop-cli` or `npx sentinelloop-cli --help`. Release tags
matching `v*` build and attach the tarball; the workflow does not publish to
npm.

## Credentials and providers

Credentials never fall back to plaintext files. Manage a named profile with:

```sh
sentinelloop auth set --profile default
sentinelloop auth status --profile default
sentinelloop auth clear --profile default
```

The live runtime uses the `default` profile. Create the non-secret config at
`%APPDATA%\SentinelLoop\config.json` on Windows or
`$XDG_CONFIG_HOME/sentinelloop/config.json` (normally
`~/.config/sentinelloop/config.json`) on macOS/Linux:

```json
{
  "schemaVersion": 1,
  "profiles": {
    "default": {
      "baseUrl": "https://api.example.com/v1",
      "model": "your-tool-capable-model",
      "allowedHeaderNames": [],
      "policies": {
        "maxIterations": 8,
        "maxDurationMs": 1800000
      }
    }
  }
}
```

`SENTINELLOOP_CONFIG` may point to another non-secret config file. API keys
belong only in the operating-system credential manager through `auth set`.

`status` reports only configuration metadata, never the key. Windows uses
PasswordVault through non-interactive PowerShell. Linux requires an installed
and unlocked `secret-tool`/libsecret service. macOS lookup and deletion use the
Keychain `security` tool, but `auth set` currently fails closed because that
tool would require placing the secret in process arguments.

The adapter supports the OpenAI-compatible Chat Completions/tool-calling
subset: one structured tool call per completion, an HTTP(S) base URL, a model,
and an explicit allowlist of non-credential extra header names. Agent runners,
provider-specific multi-call protocols, and automatic fallback are not
supported.

## Commands and lifecycle

```sh
sentinelloop run "add input validation" --repository ./target-repository
sentinelloop status <task-id>
sentinelloop resume <task-id>
sentinelloop resume <task-id> --approve
sentinelloop resume <task-id> --reject "reason"
sentinelloop report <task-id>
```

`run` prechecks the repository before creating `.sentinelloop` state. Work may
stop at `AWAITING_APPROVAL`, `PAUSED`, `SUCCEEDED`, or `FAILED`; `resume`
continues durable state and can resolve one exact pending action. `status`
prints phase and iteration budget. `report` renders a redacted Markdown audit
from state and events.

The packaged executable composes the repository precheck, durable stores,
baseline and approval services, governed file/validation tools, feedback
engine, and OpenAI-compatible client. The accepted red-test evidence is shown
for interactive confirmation before it is frozen. Run later `resume`, `status`,
and `report` commands from the target repository root.

## Offline demo and development

```sh
npm ci
npm run check
npm run demo
npm pack --dry-run
```

The demo proves three mechanisms without a network or API key: a governed
action is stopped before dispatch, fingerprinted validation feedback causes a
scripted repair, and three unchanged failure sets pause deterministically.

## Security boundary

- The model receives only registered structured tools, never a general shell.
- Realpath and write-adjacent checks confine file operations to the target
  repository; `.git`, `.sentinelloop`, credential files, and other sensitive
  paths are denied.
- Production writes are blocked until a valid failing test is accepted. Frozen
  tests require an exact, one-time approval bound to action and baseline.
- Validation uses executable/argument arrays, bounded output, timeout and
  process-tree termination. Logs, errors, reports, and model context are
  bounded and redacted.
- Repository state remains local under `.sentinelloop/`; do not commit it.

## Directory layout

```text
dist/                         packaged JavaScript, declarations and source maps
src/{domain,state,...}/       state machine and six harness dimensions
scripts/mechanism-demo.ts     reproducible offline mechanism demo
tests/                        unit, integration, fixture and demo coverage
.sentinelloop/tasks/<id>/
  state.json                  atomically replaced task snapshot
  events.jsonl                append-only, validated audit events
```

## Known limitations

- Version 0.1 targets one clean TypeScript repository and one agent; it has no
  WebUI, general shell, multi-repository planner, or automatic npm publishing.
- Version 0.1 uses the `default` provider/credential profile and requires an
  interactive terminal when a newly generated red-test baseline is confirmed.
- A red test must be a real target-test failure, not syntax, dependency,
  discovery, or infrastructure failure. Validation defaults to test,
  typecheck, lint, then build and short-circuits at the first failure.
- Keyring availability and behavior depend on the operating system; macOS
  secret creation is intentionally disabled as described above.
- Compatible endpoints can differ from the supported Chat Completions subset;
  real endpoint checks are manual opt-in and are not part of CI.

## Troubleshooting

- `DIRTY_WORKTREE`: commit or stash target-repository changes, then retry.
- `PACKAGE_MANAGER_CONFLICT`: keep exactly one supported lockfile.
- `TEST_COMMAND_MISSING`: add a package `test` script or a validated override.
- `CREDENTIAL_BACKEND_UNAVAILABLE`: install/unlock the platform credential
  service; SentinelLoop will not store the key in plaintext.
- `INVALID_CONFIG`: use an HTTP(S) base URL, non-empty model, safe extra-header
  names, and valid iteration/duration budgets.
- A paused task is not success. Inspect `status` and `report`, address the
  recorded reason, then use `resume` (and an explicit approval when requested).

## Delivery clarification and license

This project is intentionally CLI-only. Under the teaching assistant's later
clarification, a GitHub Release link and attached npm tarball replace the WebUI
delivery route. Creating a real Release and running remote CI still require an
authorized GitHub/NJU Git repository; this source tree only prepares those
workflows.

Fresh local release evidence, acceptance mappings, secret/history audit, and
placeholder-only push/PR/tag commands are recorded in
[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md). Local gates pass, but no remote
is configured and no remote CI, tag, or Release is claimed. The remaining
student-only gate is a personally authored 1500–2500-Chinese-character
`REFLECTION.md`, which is intentionally absent from the AI-authored evidence
commit.

SentinelLoop is MIT licensed. Direct dependency notices are in
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

# SentinelLoop v0.1.0 本地发布清单

日期：2026-08-14

分支：`feature-sentinelloop`

验证基线：`349da477cb1eb1ed7ab69475fba189ee929e19d9`

状态：本地代码、演示、安全和包门禁通过；未配置远程，未执行远程 CI、PR、tag 或 Release；`REFLECTION.md` 仍须学生本人完成。

## 1. Fresh local gates

| 命令 | 结果 |
|---|---|
| `npm ci` | exit 0；安装 153 个包、审计 154 个包、0 vulnerabilities |
| `npm run check` | exit 0；30 个 test files、301 tests 全过；typecheck、lint、build 均通过 |
| `npm run demo` | exit 0；治理拦截、反馈因果修复、第三轮无进展暂停三项均 PASS |
| `npm pack --dry-run` | 沙箱内首次因用户级 npm cache `EPERM` 失败；获准在沙箱外原命令重跑 exit 0；最终文档态 156 files，117.1 kB packed / 579.5 kB unpacked |
| `npm test -- tests/integration/distribution/package.test.ts` | exit 0；1 file / 1 test；离线打包、干净临时目录安装、包内 `sentinelloop --help` 通过，内容与 allowlist 完全一致 |

包内仅有 `dist/**`、`README.md`、`LICENSE`、`THIRD_PARTY_LICENSES.md` 和 `package.json`；没有源码、测试、`.env`、`.sentinelloop` 或作业过程文件。

## 2. SPEC 验收映射

所有测试均由上面的 fresh `npm run check` 覆盖。

| # | 验收标准 | 直接证据 |
|---|---|---|
| 1 | 脏工作区拒绝且不写任务 | `tests/integration/repository/precheck.test.ts`；`tests/integration/orchestrator/red-gate.test.ts` |
| 2 | npm/pnpm/yarn 与冲突 lockfile | `tests/unit/repository/discovery.test.ts`；`src/repository/package-manager.ts` |
| 3 | 测试生成期生产代码只读 | `tests/unit/governance/policy-engine.test.ts`；`tests/integration/orchestrator/red-gate.test.ts` |
| 4 | 无效红灯不能冻结 | `tests/integration/orchestrator/red-gate.test.ts` |
| 5 | 冻结测试在分发前受保护 | `tests/unit/tools/registry.test.ts`；`tests/demos/governance.demo.test.ts` |
| 6 | 越界、symlink、未知工具拒绝 | `tests/unit/governance/path-policy.test.ts`；`tests/unit/tools/registry.test.ts`；`tests/integration/tools/file-tools.test.ts` |
| 7 | Vitest/Jest/tsc/ESLint 稳定分类与指纹 | `tests/unit/feedback/parsers.test.ts`；`tests/unit/feedback/fingerprint.test.ts`；`tests/fixtures/validation/**` |
| 8 | 指定反馈改变动作并成功 | `tests/integration/orchestrator/feedback-loop.test.ts`；`tests/demos/feedback.demo.test.ts` |
| 9 | 三次无进展后暂停 | `tests/unit/feedback/feedback-engine.test.ts`；`tests/integration/orchestrator/pause-resume.test.ts`；`tests/demos/stall.demo.test.ts` |
| 10 | 最后修改后全验证通过且基线未变才成功 | `tests/unit/domain/contracts.test.ts`；`tests/unit/state/transition-table.test.ts`；`tests/integration/orchestrator/feedback-loop.test.ts` |
| 11 | 新进程恢复且事件/预算不丢 | `tests/integration/state/task-store.test.ts`；`tests/integration/orchestrator/pause-resume.test.ts` |
| 12 | auth/log/report/error 不泄密 | `tests/unit/credentials/credentials.test.ts`；`tests/unit/reporting/report.test.ts`；`tests/unit/feedback/parsers.test.ts`；`tests/integration/cli/cli.test.ts` |
| 13 | 一键测试离线、无需真实 LLM | `npm run check`；`src/llm/scripted-client.ts`；全部测试使用 fake/scripted transport |
| 14 | tarball 干净安装并运行 help | `tests/integration/distribution/package.test.ts`；`npm pack --dry-run` |
| 15 | GitLab `unit-test` 与 GitHub 三平台/Release | `.gitlab-ci.yml`；`.github/workflows/ci.yml`；`.github/workflows/release.yml`（仅本地静态证据，未声称远程成功） |

## 3. 六维实现映射

| 维度 | 代码 | 测试/命令证据 |
|---|---|---|
| 决策 | `src/state/transition-table.ts`、`src/orchestrator/task-orchestrator.ts`、`src/llm/**` | state、LLM、orchestrator suites；`npm run demo` |
| 工具 | `src/tools/registry.ts`、`file-tools.ts`、`validation-tool.ts` | `tests/unit/tools/**`、`tests/integration/tools/**` |
| 记忆 | `src/state/task-store.ts`、`event-store.ts`、`src/llm/context-builder.ts` | state recovery、pause/resume、context selection tests |
| 治理 | `src/governance/**` | governance suites、governance demo |
| 反馈 | `src/feedback/**` | feedback suites、feedback/stall demos |
| 配置 | `src/config/**`、`src/repository/validation-discovery.ts`、TaskState budget schemas | config、repository discovery、domain/feedback budget tests |

## 4. 秘密、测试标记和产物审计

对下列规则逐项执行 tracked-tree 扫描 `git grep -I -l -E -- <RULE> HEAD -- .`，并执行历史 diff 扫描 `git log --all --format=COMMIT:%H --name-only -G<RULE> -- .`：GitHub/OpenAI/AWS/npm/Slack token、private-key header、Bearer token、嵌入凭据 URL，以及 credential-shaped assignment。只记录规则和路径，不回显匹配值。

- GitHub-shaped token：tracked 1 file；history 1 commit / 1 path，均为 `tests/unit/feedback/feedback-engine.test.ts` 的刻意脱敏假令牌。
- Bearer-shaped token：tracked 3 files；history 2 commits / 3 paths，均为 `tests/unit/credentials/credentials.test.ts`、`tests/unit/feedback/parsers.test.ts`、`tests/unit/reporting/report.test.ts` 的刻意脱敏假令牌。
- OpenAI、AWS、npm、Slack、private key、credential URL、通用凭据赋值规则：tracked 与 history 均 0。
- 结论：0 个真实秘密。假令牌只用于证明反馈、日志和报告脱敏。

产物/标记审计：

- `git ls-files` 与 `git rev-list --objects --all` 对 `.env*`、`.sentinelloop/**`、`*.tgz`、`.demo-dist/**`、tmp/temp/bak/swp 路径均为 0；`git status --short --branch` 在门禁后干净。
- focused/skipped/todo tests、`@ts-ignore`/`@ts-nocheck`、coverage suppression、`eslint-disable` 均为 0。
- TODO/FIXME/TBD/XXX 规则仅命中 `PLAN.md` 中“没有 TBD/TODO”的自检说明，不是实现占位。
- `dist/**` 是 `package.json#files` 指定的发布运行时；fresh build 后 Git 无差异。`node_modules/**` 被忽略且不入包。

## 5. 两阶段最终复核

1. Spec compliance：上表逐项覆盖 15 条验收标准与六维机制；无未映射的本地验收项。
2. Quality/security：fresh tests、typecheck、lint、build、三项 demo、包 smoke、secret/history/artifact/marker audit 均完成；未发现 Critical 或 Important 本地发布问题。

本机仅实际验证 Windows。macOS/Linux 的本地证据是平台分支单测与 CI 定义；真实三平台结果必须以远程 CI 为准。

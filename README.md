# SentinelLoop

> 确定性单智能体 TDD 编码智能体运行框架(AI4SE 期末项目 · A 类 Coding Agent Harness)

**GitHub 仓库:** <https://github.com/ddongz/agent-loop>

SentinelLoop 是一个 **Node.js CLI 命令行工具**,用于在一个干净的 TypeScript Git 仓库中执行**确定性的、单智能体 TDD(测试驱动开发)循环**:

1. 你给一句自然语言需求(如 "add input validation")和一个目标仓库
2. SentinelLoop 驱动 LLM 先写**红灯测试**(真实失败的测试),把失败证据交给你**交互确认**后冻结基线
3. 冻结后 LLM 才能修改生产代码,实现需求让测试转绿
4. 每轮自动执行验证计划(test → typecheck → lint → build,遇错即停),用**验证结果指纹**做确定性的停止决策(继续 / 暂停 / 成功 / 失败)
5. 全程可审计:任务状态、事件日志、脱敏报告随时可查,任务可随时恢复

核心治理理念:**模型永远拿不到 Shell**。它只有 8 个结构化工具,每个动作都要依次通过 Schema 校验、阶段策略和路径策略;红灯测试被冻结;所有停止决策都由可复现的规则决定。

## 架构概览

- `TaskOrchestrator` 维护显式阶段状态机:`PRECHECK → ANALYZE_REQUIREMENT → GENERATE_TESTS → CONFIRM_RED → FREEZE_TESTS → IMPLEMENT → VALIDATE → FEEDBACK → SUCCEEDED`,以及 `AWAITING_APPROVAL` / `PAUSED` / `FAILED` 边界
- 所有 LLM 操作经过运行时 Schema → 策略引擎 → 结构化工具注册表,**没有通用 Shell 工具**
- `state.json` + `events.jsonl` 持久化任务状态,支持恢复;验证结果指纹和预算(迭代次数 / 时长 / Token / 费用)保证停止决策确定性
- 生产适配器可替换为脚本化 LLM,支持**离线、无 API Key** 的机制演示

## 环境要求

- Node.js **≥ 22.12.0**,Windows / macOS / Linux
- 目标仓库必须是**干净的 TypeScript / Node.js Git 仓库**:
  - 根目录有有效的 `.git`,且在某个分支上(至少一次提交)
  - 工作区干净(`git status` 无任何未提交/未跟踪文件)
  - 有 `package.json`,且提供 `test` 脚本
  - 只用一种包管理器锁文件(npm / pnpm / yarn 之一)
  - 建议在 `.gitignore` 中加入 `.sentinelloop/`(任务状态目录不应提交)

## 安装

从 GitHub Release 下载 tarball,或本地构建打包:

```sh
cd agent-loop
npm ci
npm run check      # test + typecheck + lint + build
npm pack           # 生成 sentinelloop-cli-0.1.0.tgz
npm install -g ./sentinelloop-cli-0.1.0.tgz
sentinelloop --help
```

打 `v*` 标签的 Release 工作流会自动构建并附加 tarball(不会自动发布 npm)。

## 配置

### 1. 创建配置文件(不含敏感信息)

- Windows:`%APPDATA%\SentinelLoop\config.json`
- macOS / Linux:`~/.config/sentinelloop/config.json`
- 也可用环境变量 `SENTINELLOOP_CONFIG` 指向其他配置文件

示例(DeepSeek):

```json
{
  "schemaVersion": 1,
  "profiles": {
    "default": {
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "deepseek-chat",
      "allowedHeaderNames": [],
      "policies": {
        "maxIterations": 8,
        "maxDurationMs": 1800000
      }
    }
  }
}
```

字段说明:

- `baseUrl`:OpenAI 兼容端点的 HTTP(S) 地址(不含 `/chat/completions`,不得内嵌账号密码)
- `model`:支持工具调用的模型名
- `allowedHeaderNames`:允许额外发送的非凭据请求头白名单
- `policies.maxIterations`(1–32)、`maxDurationMs`(≥1000):任务预算

### 2. 保存 API Key(存入系统凭据管理器,绝不写入明文)

```sh
sentinelloop auth set --profile default     # 交互式隐藏输入,粘贴 API Key
sentinelloop auth status --profile default  # 只显示元数据,不显示 Key
sentinelloop auth clear --profile default
```

- Windows 使用 PasswordVault;Linux 需要已安装并解锁的 `secret-tool`/libsecret;macOS 的 `auth set` 目前故意失败关闭(fail closed)
- 支持任意 **OpenAI 兼容 Chat Completions** 端点;不支持 Agent Runner、提供商专属多工具协议、自动降级

## 使用指南

在**目标仓库根目录**下运行:

```sh
# 启动任务(先做仓库预检查,再创建 .sentinelloop 状态)
sentinelloop run "add input validation" --repository D:\minicode\test

# 查看 / 恢复 / 审批
sentinelloop status <task-id>
sentinelloop resume <task-id>
sentinelloop resume <task-id> --approve          # 批准一次待处理操作
sentinelloop resume <task-id> --reject "reason"  # 拒绝并附理由

# 生成脱敏的 Markdown 审计报告
sentinelloop report <task-id>
```

### 一次正确运行的完整过程

1. **启动**:预检查(仓库合法、工作区干净)静默通过后创建任务
2. **写红灯测试**:模型在 `GENERATE_TESTS` 阶段用 `create_file` / `apply_patch` 写测试,再调用 `run_validation`
3. **交互确认**:harness 执行 `npm test` 检测到**真实测试失败**(断言失败/运行时失败;语法错误、依赖问题、测试发现问题会被拒绝),终端弹出确认:
   ```
   Confirm this failing-test baseline?
   test:failed TEST_ASSERTION expected ... [src/index.test.ts:8:18 ...]
   - src/index.test.ts: test names ...
   [y/N]
   ```
   输入 `y` → 红灯基线冻结;`n` → 模型回去重写
4. **实现**:模型在 `IMPLEMENT` 阶段修改生产代码,调用 `finish` 触发完整验证计划
5. **收尾**:
   - 全绿且基线/策略校验通过 → `Task <id>: SUCCEEDED`
   - 模型动了冻结的测试 → `Task <id>: AWAITING_APPROVAL`,由你决定批准或拒绝(如 `--reject "do not modify frozen tests"`)
   - 连续 3 次相同失败 / 预算耗尽 / 停滞 → `Task <id>: PAUSED`,查看 `report` 后 `resume` 继续
   - 不可恢复 → `Task <id>: FAILED`

### 提示

- **需求要有真实含义**:空需求("...")会让模型制造占位失败测试糊弄红灯门,应使用具体、可测试的需求描述
- 任务状态保存在目标仓库的 `.sentinelloop/` 目录,**不要提交**;每次 `run` 前请提交目标仓库的改动,否则预检查报 `DIRTY_WORKTREE`
- 模型偶尔会一次返回多个工具调用(部分端点忽略 `parallel_tool_calls: false`),客户端会确定性地取第一个校验通过的动作执行,不影响流程
- 同一阶段内模型连续 24 个动作未触发验证会暂停,原因记为 `STALL_DETECTED`,`resume` 即可继续

## 离线演示与开发

```sh
npm ci
npm run check
npm run demo          # 无网络、无 Key,演示三大核心机制
npm pack --dry-run
```

`npm run demo` 证明三件事:

1. 受治理的操作在执行前被策略拦截
2. 带指纹的验证反馈驱动脚本化模型完成修复
3. 同一组失败连续三次时任务确定性暂停

## 安全边界

- 模型只能访问注册过的结构化工具(`read_file`、`list_files`、`search_files`、`create_file`、`apply_patch`、`run_validation`、`finish`、`request_clarification`),**永远拿不到通用 Shell**
- 文件操作经 realpath 与写入关联检查限制在目标仓库内;`.git`、`.sentinelloop`、凭据文件等敏感路径一律拒绝
- 有效的失败测试被接受之前,生产代码写入被阻止;修改冻结测试需要一次性精确审批,审批与具体操作和基线绑定
- 验证进程使用"可执行程序 + 参数数组"调用,限制输出大小,支持超时与进程树终止
- 日志、错误、报告、模型上下文全部限长并脱敏;API Key 只进系统凭据管理器

## 故障排查

| 报错 | 处理 |
|---|---|
| `DIRTY_WORKTREE` | 提交或暂存目标仓库的改动后重试 |
| `NOT_GIT_REPOSITORY` / `Repository root must contain .git.` | 目标仓库根目录缺少有效 `.git`(空目录无效),`git init` 并至少提交一次 |
| `PACKAGE_MANAGER_CONFLICT` | 只保留一种受支持的锁文件 |
| `TEST_COMMAND_MISSING` | 在 `package.json` 添加 `test` 脚本(占位符 `echo Error` 过不了红灯验证) |
| `INVALID_CONFIG` | 检查 Base URL、model、header 白名单、预算字段的合法性 |
| `CREDENTIAL_BACKEND_UNAVAILABLE` | 安装并解锁对应平台的凭据服务,重新 `auth set` |
| `LLM_PROTOCOL` | 端点响应不符合 Chat Completions 契约;换用支持工具调用的模型或端点 |
| 任务 `PAUSED` | 先看 `sentinelloop status/report <task-id>` 中的暂停原因,再 `resume` |

## 已知限制(0.1)

- 只面向一个干净的 TypeScript 仓库和一个智能体
- 无 WebUI,纯 CLI
- 无通用 Shell、无多仓库规划器
- 只支持 OpenAI 兼容 Chat Completions 子集
- 红灯基线确认必须在交互式终端完成
- 不自动发布 npm

## 目录结构

```text
dist/                         打包后的 JS、类型声明和 source map
src/{domain,state,...}/       状态机、治理、验证等模块
scripts/mechanism-demo.ts     可复现的离线机制演示
tests/                        单元、集成、fixture 和 demo 测试
.sentinelloop/tasks/<id>/     目标仓库内的任务状态(勿提交)
  state.json                  原子替换更新的任务快照
  events.jsonl                只追加、经过校验的审计事件
```

## 许可证

MIT License。直接依赖项的许可证声明见 [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)。

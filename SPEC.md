# SentinelLoop 软件设计规格

版本：0.1.0  
日期：2026-08-14  
状态：设计已确认，待冷启动验证

## 1. 问题陈述

### 1.1 问题

现有 Coding Agent 可以根据自然语言修改代码，但完成判断经常依赖模型自述，失败输出缺少稳定分类，反复修改可能无进展或震荡，测试也可能被 Agent 降低断言或删除以制造“成功”。这使用户很难判断一次新增功能任务是否真正按 TDD 完成。

### 1.2 目标用户

- 希望在本地 TypeScript/Node.js 仓库中安全使用 Coding Agent 的个人开发者；
- 研究 agentic software engineering、需要可重复机制演示的学生和教师；
- 需要审计 Agent 动作、验证结果和暂停原因的工具作者。

### 1.3 价值

SentinelLoop 将“测试先行、测试保护、验证反馈、进展判断和停机”实现为确定性代码，而非提示词约束。用户可审查每轮动作与反馈，并在无网络的 mock 模式下重现核心行为。

## 2. 范围

### 2.1 首版范围

- TypeScript/Node.js >=22.12.0 Git 仓库；
- npm、pnpm、yarn，按 lockfile 自动识别；
- CLI 自然语言需求输入；
- Agent 先生成测试，再实现功能；
- OpenAI Chat Completions 风格 tool calling 兼容端点；
- 结构化文件、搜索和验证工具；
- 测试冻结、路径围栏、阶段权限和终端审批；
- test、typecheck、lint、build 反馈闭环；
- `.sentinelloop/` 本地可恢复状态；
- npm 包和 GitHub Release 分发；
- Windows、macOS、Linux。

### 2.2 非目标

- 非 TypeScript/Node.js 目标仓库；
- 任意 shell、自动 Git 远程写入、自动发布或部署；
- 多 Agent 编排；
- WebUI；根据助教后续说明，以 Release 链接替代原始 WebUI 要求；
- 完整支持所有 OpenAI 兼容供应商的非标准扩展。

## 3. 用户故事

1. 作为 TypeScript 开发者，我希望用一句自然语言描述新增功能，以便 Harness 自动建立 TDD 任务。
2. 作为谨慎的仓库所有者，我希望脏工作区被拒绝启动，以免 Agent 覆盖未提交工作。
3. 作为任务发起者，我希望在实现前看到新增测试的 diff 和有效红灯，以便确认验收基线。
4. 作为仓库所有者，我希望冻结测试未经批准不能被修改或删除，以免 Agent 伪造成功。
5. 作为开发者，我希望测试、类型、lint 和构建失败被结构化回灌，以便 Agent 根据客观信号修复。
6. 作为成本敏感的用户，我希望无进展、震荡或预算耗尽时自动暂停，以免无限消耗。
7. 作为安全敏感的用户，我希望越界或危险动作在执行前被拦截，并在终端中明确审批。
8. 作为任务审计者，我希望查看状态、事件、审批和最终报告，以便重现任务过程。
9. 作为多端点用户，我希望配置 OpenAI 兼容的 base URL、模型和附加请求头，以便使用自己的服务。
10. 作为 CLI 用户，我希望 API Key 存在系统凭据管理器，并可安全录入、查看状态、更新和清除。

每个故事可以独立实现和验证，具有明确用户价值，范围足够小，并在第 12 节给出可测试验收标准，符合 INVEST 原则。

## 4. 功能规约

### 4.1 凭据和配置

输入：`auth set/status/clear` 命令、profile、base URL、模型和可选附加请求头。  
行为：隐藏录入 API Key；保存在系统凭据管理器；非敏感配置写入用户级配置；状态命令只显示是否配置及更新时间。  
输出：稳定退出码和脱敏状态。  
边界：不允许把 Key 写入仓库、任务状态、日志或错误栈。  
错误：凭据后端不可用时给出平台相关恢复建议，不静默退回明文文件。

### 4.2 任务启动与预检

输入：自然语言需求、目标仓库路径、可选 profile/预算/命令覆盖。  
行为：验证 Git 仓库和干净工作区；检查 Node 22+；识别包管理器；发现验证脚本；创建 task ID 和状态目录。  
输出：任务摘要或明确的预检错误。  
边界：需求不得为空；仓库必须可解析为真实路径；当前分支不可处于不可审计状态。  
错误：脏工作区、缺少 package.json、无支持的包管理器或无测试命令时拒绝启动。

### 4.3 需求分析与测试生成

输入：原始需求、仓库摘要、相关文件。  
行为：LLM 通过只读工具探索仓库，随后只在允许的测试路径内创建/修改测试。生产代码在此阶段只读。  
输出：测试 diff、需求—测试映射、验证请求。  
边界：模型只能调用当前阶段允许的结构化工具。  
错误：格式错误动作被拒绝并作为协议观察回灌；重复无效动作计入停机检测。

### 4.4 红灯确认与测试冻结

输入：测试运行结果和测试 diff。  
行为：排除语法、依赖、发现和基础设施错误；展示测试 diff、失败摘要和需求映射；用户确认后保存路径、SHA-256 和 diff。  
输出：有效测试基线或返回测试生成阶段。  
边界：没有实际测试变化或没有发现目标测试时不得冻结。  
错误：无效红灯会生成结构化反馈，不进入实现阶段。

### 4.5 实现与工具执行

输入：结构化动作。  
行为：Action Parser 校验；Policy Engine 判定；Tool Dispatcher 执行读、搜、创建、补丁和验证工具；记录 Observation。  
输出：受限观察、diff 摘要或验证结果。  
边界：路径必须在工作区；受保护测试不可写；LLM 不获得通用 shell。  
错误：未知工具、非法参数、越界路径、冲突 patch 和超时均转换为统一错误观察。

### 4.6 验证与反馈

输入：test、typecheck、lint、build 命令输出。  
行为：按顺序短路执行；解析为 ValidationResult；生成问题类别和指纹；比较上一轮并计算进展；构造紧凑反馈。  
输出：成功、继续修复、暂停或失败决定。  
边界：命令只能来自自动发现或用户配置，LLM 无权改写。  
错误：环境错误与功能错误分离，避免要求 LLM 修复不可修复环境。

### 4.7 审批、暂停和恢复

输入：需审批动作或 `resume` 命令。  
行为：保存完整待审批状态；终端展示风险、动作和理由；支持批准一次或拒绝；恢复前重验仓库和测试基线。  
输出：恢复执行、保持暂停或失败。  
边界：批准只适用于精确动作，不形成永久通配权限。  
错误：工作区变化、基线变化或配置不一致时拒绝恢复并解释原因。

### 4.8 状态和报告

输入：task ID。  
行为：读取事件和状态；生成当前阶段、轮次、预算、最后反馈、审批和最终验证摘要。  
输出：终端状态或 Markdown 报告。  
边界：报告脱敏，默认存于 `.sentinelloop/`，可显式导出。  
错误：未知或损坏任务返回非零退出码，不擅自重建状态。

## 5. 非功能需求

### 5.1 性能

- 除外部 LLM 和验证命令外，单个工具调度的框架开销目标低于 100 ms；
- 单条 stdout/stderr 默认最多保留 64 KiB，回灌摘要最多 8 KiB；
- 默认最多 8 个实现轮次；每个验证命令有可配置超时；
- 状态和事件采用流式/追加方式，任务恢复不加载无关完整日志到 LLM。

### 5.2 安全与凭据威胁模型

| 威胁 | 对策 | 剩余风险 |
|---|---|---|
| Key 进入源码/Git | 系统凭据管理器；仓库不存 Key；secret 扫描 | 用户可手动复制泄漏 |
| Key 进入日志/异常 | 统一敏感值脱敏器；不记录请求头 | 第三方 SDK 未知格式 |
| Key 进入 shell history | `auth set` 隐藏交互，不接受命令行明文参数 | 终端/系统级键盘记录 |
| `.env` 明文泄漏 | 默认不支持 `.env` 作为持久存储 | 用户可自行设置进程环境 |
| 进程环境可见 | Key 直接由凭据服务传入客户端，不导出环境变量 | 同用户高权限进程仍可能观察内存 |
| 路径逃逸 | realpath/规范化后验证工作区前缀和符号链接 | OS/文件系统竞态需原子检查 |
| 测试被篡改 | 哈希基线、写前策略检查、最终复验 | 用户批准后可能接受弱测试 |
| 危险副作用 | 无通用 shell；危险动作 DENY/审批；单次授权 | 底层工具库漏洞 |

### 5.3 可用性

- 三平台行为一致；
- 错误信息包含原因、影响和可操作恢复步骤；
- `status`/`report` 可在任务暂停或进程崩溃后使用；
- Ctrl+C 保存一致状态并以专用退出码结束。

### 5.4 可观测性

- 每个任务使用 JSONL 事件日志，包含时间、状态、动作类型、策略结果、验证摘要和预算；
- 不记录完整敏感请求或 API Key；
- 最终报告可追踪需求、基线、每轮反馈、审批和最终验证。

## 6. 系统架构

```text
CLI
 │
 ▼
Task Application Service
 │
 ▼
Task Orchestrator / Explicit State Machine
 ├── Context Builder ───────────── Memory Selector
 ├── LLMClient ─────────────────── Scripted / OpenAI-Compatible
 ├── Action Parser
 ├── Policy Engine ─────────────── Approval Manager
 ├── Tool Dispatcher ───────────── File / Search / Validation Tools
 ├── Feedback Engine ───────────── Parsers / Classifier / Progress Detector
 └── Task Store ────────────────── Events / Baseline / Report

Credential Service ── OS Credential Manager
Config Service ────── User config + repository discovery
```

数据流：用户需求进入应用服务；预检结果和仓库摘要进入状态机；Context Builder 只选择当前阶段所需信息；LLM 返回结构化动作；动作经解析、治理后才可执行；Observation 和 ValidationResult 进入事件存储与 Feedback Engine；确定性停机规则控制状态迁移。

## 7. 数据模型

### 7.0 权威字面量

```ts
type TaskPhase =
  | "PRECHECK"
  | "ANALYZE_REQUIREMENT"
  | "GENERATE_TESTS"
  | "CONFIRM_RED"
  | "FREEZE_TESTS"
  | "IMPLEMENT"
  | "VALIDATE"
  | "FEEDBACK"
  | "AWAITING_APPROVAL"
  | "PAUSED"
  | "SUCCEEDED"
  | "FAILED";

type ActivePhase = Exclude<TaskPhase, "AWAITING_APPROVAL" | "PAUSED" | "SUCCEEDED" | "FAILED">;
type ValidatorName = "test" | "typecheck" | "lint" | "build";
type ValidationStatus = "passed" | "failed" | "infrastructure_error";
type IssueSeverity = "error" | "warning";
type ValidationIssueCategory =
  | "TEST_ASSERTION" | "TEST_RUNTIME" | "TEST_DISCOVERY"
  | "SYNTAX_ERROR" | "TYPE_ERROR" | "LINT_ERROR" | "BUILD_ERROR"
  | "DEPENDENCY_ERROR" | "TIMEOUT" | "INFRASTRUCTURE_ERROR" | "UNKNOWN";

type SentinelErrorCode =
  | "INVALID_INPUT" | "INVALID_CONFIG" | "INVALID_TRANSITION"
  | "DIRTY_WORKTREE" | "UNSUPPORTED_NODE_VERSION" | "NOT_GIT_REPOSITORY"
  | "PACKAGE_JSON_MISSING" | "PACKAGE_MANAGER_CONFLICT" | "TEST_COMMAND_MISSING"
  | "PATH_ESCAPE" | "PROTECTED_TEST" | "POLICY_DENIED" | "APPROVAL_REQUIRED"
  | "UNKNOWN_ACTION" | "INVALID_ACTION" | "PATCH_CONFLICT" | "TOOL_TIMEOUT"
  | "VALIDATION_INFRASTRUCTURE" | "LLM_AUTH" | "LLM_RATE_LIMIT" | "LLM_TIMEOUT"
  | "LLM_UNAVAILABLE" | "LLM_PROTOCOL" | "SCRIPT_NO_MATCH"
  | "CREDENTIAL_BACKEND_UNAVAILABLE" | "TASK_NOT_FOUND" | "STATE_CORRUPT"
  | "PERSISTENCE_FAILED" | "INTERNAL";
```

`REQUEST_SUCCESS_CHECK` 是 Feedback Engine 的决定，不是任务阶段。首版没有 `CANCELLED`；用户中止会保存为 `PAUSED`，原因是 `USER_INTERRUPTED`。

### 7.0.1 权威状态转移

不允许自循环。未列出的转移全部非法。`SUCCEEDED` 和 `FAILED` 是终态。

| 当前阶段 | 允许的后继阶段 |
|---|---|
| PRECHECK | ANALYZE_REQUIREMENT, `resumePhase`, FAILED |
| ANALYZE_REQUIREMENT | GENERATE_TESTS, AWAITING_APPROVAL, PAUSED, FAILED |
| GENERATE_TESTS | CONFIRM_RED, AWAITING_APPROVAL, PAUSED, FAILED |
| CONFIRM_RED | FREEZE_TESTS, GENERATE_TESTS, PAUSED, FAILED |
| FREEZE_TESTS | IMPLEMENT, FAILED |
| IMPLEMENT | VALIDATE, AWAITING_APPROVAL, PAUSED, FAILED |
| VALIDATE | FEEDBACK, SUCCEEDED, AWAITING_APPROVAL, PAUSED, FAILED |
| FEEDBACK | IMPLEMENT, PAUSED, FAILED |
| AWAITING_APPROVAL | `resumePhase`, PAUSED, FAILED |
| PAUSED | PRECHECK |

进入 `AWAITING_APPROVAL` 或 `PAUSED` 时必须保存非终态 `resumePhase`。恢复 `PAUSED` 必须先进入 `PRECHECK` 复验仓库，再由预检成功逻辑返回所保存的 `resumePhase`；这是 PRECHECK 的一个恢复分支，不允许调用者跳过预检。审批批准后只能进入 `pendingApproval.resumePhase`；拒绝后进入 `PAUSED`。正常新任务的 PRECHECK 只能进入 ANALYZE_REQUIREMENT。

权威 API 为 `canTransition(state: TaskState, to: TaskPhase): boolean` 和 `transition(state: TaskState, to: TaskPhase, now: string): TaskState`。二者必须使用同一判定函数；`canTransition` 不抛错，`transition` 在 false 时抛 `INVALID_TRANSITION`。动态规则：`AWAITING_APPROVAL` 只有存在 pendingApproval 且 `to === pendingApproval.resumePhase` 时可批准恢复；`PAUSED` 只能到 PRECHECK；`PRECHECK` 在 `resumePhase === null` 时只能正常进入 ANALYZE_REQUIREMENT，在非空且预检已由调用方成功完成时只能进入该 resumePhase 或 FAILED。每次成功转移更新 `updatedAt`；离开 AWAITING_APPROVAL 后清空 pendingApproval；消费 PRECHECK 恢复分支后清空 resumePhase；进入终态同时清空 resumePhase。

### 7.1 TaskState

```ts
interface Budget {
  maxIterations: number;       // integer 1..32, default 8
  maxDurationMs: number;       // integer >=1000, default 1_800_000
  maxTokens: number | null;    // positive integer or null = not enforced
  maxCostUsd: number | null;   // positive finite number or null = not enforced
}

interface Usage {
  iterations: number;          // non-negative integer
  elapsedMs: number;           // non-negative integer
  inputTokens: number;         // non-negative integer
  outputTokens: number;        // non-negative integer
  costUsd: number | null;      // non-negative finite number, null if provider omits cost
}

interface ValidationCommand {
  validator: ValidatorName;
  executable: string;          // discovered package-manager executable
  args: string[];              // no shell string
  timeoutMs: number;           // integer >=1000
  enabled: boolean;
}

interface ProtectedTestRef {
  path: string;                // normalized repository-relative POSIX path
  sha256: string;              // 64 lowercase hex chars
  frozenAt: string;            // ISO-8601
}

interface ValidationSnapshot {
  results: ValidationResult[]; // exactly one latest result per enabled validator
  baselineVerified: boolean;
  workspacePolicyVerified: boolean;
  codeVersion: string;         // SHA-256 of the normalized working-tree diff
  completedAt: string;         // ISO-8601, after every included validator ended
}

interface PendingApproval {
  action: Action;
  decisionReason: string;
  requestedAt: string;
  resumePhase: ActivePhase;
  baselineVersion: number;
}

interface TaskState {
  schemaVersion: 1;
  id: string;
  repositoryRoot: string;
  requirement: string;
  phase: TaskPhase;
  resumePhase: ActivePhase | null;
  iteration: number;
  budget: Budget;
  usage: Usage;
  validationPlan: ValidationCommand[];
  protectedTests: ProtectedTestRef[];
  baselineVersion: number;
  pendingApproval: PendingApproval | null;
  lastFeedback: Feedback | null;
  lastError: SerializedSentinelError | null;
  lastCodeChangeAt: string | null;
  finalValidationAt: string | null;
  finalValidation: ValidationSnapshot | null;
  createdAt: string;
  updatedAt: string;
}
```

所有字段必填；可缺省概念使用显式 `null` 或空数组。`TaskStateSchema` 的 `phase === "SUCCEEDED"` 精化必须满足：`finalValidationAt !== null`、`finalValidation !== null`、两者时间相等、`lastCodeChangeAt === null || finalValidationAt >= lastCodeChangeAt`、`pendingApproval === null`、`finalValidation.baselineVerified === true`、`workspacePolicyVerified === true`，以及 `validationPlan` 中每个启用 validator 在 `finalValidation.results` 恰有一个 `passed` 结果。实际文件哈希和工作区 diff 的计算由 Task 8 在创建 ValidationSnapshot 前完成；TaskState schema 验证快照的完整性与一致性，而不是重新访问文件系统。

### 7.2 Event

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type EventType =
  | "TASK_CREATED" | "PHASE_CHANGED" | "ACTION_REQUESTED" | "POLICY_DECIDED"
  | "ACTION_COMPLETED" | "VALIDATION_COMPLETED" | "FEEDBACK_CREATED"
  | "BASELINE_FROZEN" | "APPROVAL_REQUESTED" | "APPROVAL_RESOLVED"
  | "TASK_PAUSED" | "TASK_RESUMED" | "TASK_SUCCEEDED" | "TASK_FAILED"
  | "USER_INTERRUPTED";

interface TaskEvent {
  schemaVersion: 1;
  id: string;
  taskId: string;
  sequence: number;             // positive integer, starts at 1 per task
  type: EventType;
  timestamp: string;            // ISO-8601
  phaseBefore: TaskPhase | null;
  phaseAfter: TaskPhase | null;
  actionId: string | null;
  observationActionId: string | null;
  causationEventId: string | null;
  payload: { [key: string]: JsonValue }; // already redacted before append
}
```

EventStore assigns `sequence`; callers cannot select it. `TASK_CREATED` has `phaseBefore: null`, `phaseAfter: "PRECHECK"`; `PHASE_CHANGED` requires both phases; action events require `actionId`; `ACTION_COMPLETED` may set `observationActionId` to the same action ID; other non-applicable references are explicit `null`. On load, every JSONL row must pass `TaskEventSchema`, task IDs must match, sequences must be contiguous from 1, IDs unique, and timestamps nondecreasing; otherwise throw `STATE_CORRUPT`.

### 7.3 Action / Observation

所有 Action 使用严格判别联合，未知字段被拒绝：

```ts
interface ActionBase { version: 1; id: string; rationale: string; }
type Action =
  | (ActionBase & { type: "read_file"; path: string; maxBytes?: number })
  | (ActionBase & { type: "list_files"; path?: string; maxDepth?: number; maxEntries?: number })
  | (ActionBase & { type: "search_files"; query: string; path?: string; glob?: string; maxResults?: number })
  | (ActionBase & { type: "create_file"; path: string; content: string })
  | (ActionBase & { type: "apply_patch"; path: string; patch: string })
  | (ActionBase & { type: "run_validation"; validator: ValidatorName | "all" })
  | (ActionBase & { type: "finish"; summary: string })
  | (ActionBase & { type: "request_clarification"; question: string });
```

约束：`id` 1..64 字符；`rationale`/`summary`/`question` 1..2000；路径 1..4096；`maxBytes` 1..1,048,576，默认 65,536；`maxDepth` 0..20，默认 5；`maxEntries`/`maxResults` 1..1000，默认 200；`query` 1..1000；`glob` 1..500；`content`/`patch` 最大 1 MiB。`apply_patch.patch` 是只针对 `path` 的 unified diff，文件头必须与该路径一致；不能在一个动作中修改多个文件。`run_validation` 只引用已发现的 ValidationCommand，不能携带命令。

```ts
interface Observation {
  actionId: string;
  tool: Action["type"];
  status: "succeeded" | "failed" | "denied" | "approval_required";
  startedAt: string;
  durationMs: number;
  output: string;
  truncated: boolean;
  error: SerializedSentinelError | null;
}
```

### 7.4 TestBaseline

- 文件规范化相对路径；
- SHA-256；
- 冻结时 diff；
- 用户确认时间；
- 经批准的后续版本记录。

### 7.5 ValidationResult / Issue / Feedback

```ts
interface ValidationIssue {
  category: ValidationIssueCategory;
  severity: IssueSeverity;
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  rule: string | null;
  testName: string | null;
  fingerprint: string;
}

interface ValidationResult {
  validator: ValidatorName;
  status: ValidationStatus;
  exitCode: number | null;
  command: { executable: string; args: string[] };
  startedAt: string;
  durationMs: number;
  issues: ValidationIssue[];
  stdoutSummary: string;
  stderrSummary: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

type Progress =
  | { kind: "improved"; resolved: string[]; introduced: string[] }
  | { kind: "unchanged"; repeated: string[] }
  | { kind: "regressed"; introduced: string[] }
  | { kind: "oscillating"; cycleLength: 2 | 3 };

interface Feedback {
  decision: "CONTINUE" | "PAUSE_NO_PROGRESS" | "PAUSE_BUDGET" | "REQUEST_SUCCESS_CHECK" | "FAIL_INFRASTRUCTURE";
  summary: string;
  currentStage: ValidatorName | null;
  progress: Progress | null;
  issues: ValidationIssue[];
  remainingIterations: number;
  createdAt: string;
}
```

### 7.6 错误对象

```ts
interface SerializedSentinelError {
  code: SentinelErrorCode;
  message: string; // user-facing, already redacted
  retryable: boolean;
  recoverable: boolean;
  detail: { [key: string]: JsonValue } | null; // already redacted
}

class SentinelError extends Error {
  readonly code: SentinelErrorCode;
  readonly retryable: boolean;
  readonly recoverable: boolean;
  readonly detail: { [key: string]: JsonValue } | null;
  toJSON(redact: (value: JsonValue) => JsonValue): SerializedSentinelError;
  static fromJSON(value: SerializedSentinelError): SentinelError;
}
```

`SentinelError` 的 `name` 固定为 `"SentinelError"`，原始 `cause` 可以保留在进程内但不得序列化。所有字段必填；无 detail 使用 `null`。`toJSON` 必须先对 message/detail 脱敏。相同 code 的 retryable/recoverable 默认映射由 `error.ts` 常量定义，但构造函数允许适配器在有依据时覆盖。

## 8. 领域与机制设计

### 8.1 六维实现

| 维度 | 代码机制 | 离线验证 |
|---|---|---|
| 决策 | 显式阶段状态机、上下文构造、LLM 接口、动作解析、停机 | Scripted LLM 驱动状态迁移 |
| 工具 | 注册表、Zod schema、阶段许可、分发、超时、Observation | 内存/临时仓库工具测试 |
| 记忆 | JSON/JSONL Task Store、事件索引、最近反馈/决策选择 | 跨实例恢复与选择测试 |
| 治理 | 路径围栏、测试哈希、阶段权限、单次审批 | 危险/越界/测试修改必然拦截 |
| 反馈 | parser、分类、指纹、进展、震荡、结构化回灌 | 固定输出产生固定反馈/停机 |
| 配置 | schema、profile、发现、覆盖、预算和策略执行 | 合法/非法/默认/覆盖测试 |

### 8.2 主要贡献：确定性反馈闭环

验证顺序默认 `test → typecheck → lint → build`，失败时短路。Vitest/Jest、tsc、ESLint 和构建输出被解析为统一结果，问题分类为测试断言/运行/发现、语法、类型、lint、构建、依赖、超时、基础设施或未知错误。

失败指纹由验证器、类别、规范化路径、测试/规则名和消息模板构成，并去除行号、耗时、随机 ID 和具体值。Progress Detector 比较问题数量、严重度、已解决/新增指纹、最早失败阶段和有效 diff，输出 improved、unchanged、regressed 或 oscillating。

相同指纹集合连续 3 轮不变、长度 2/3 的失败集合循环、重复动作与观察、无有效 diff、总轮次 8、时间/token/费用预算耗尽，均会确定性暂停。LLM 的 `finish` 只触发最终验收，不能直接成功。

### 8.3 测试冻结

红灯必须发现目标测试，且不能只是语法、依赖、发现或基础设施错误。冻结前 CLI 展示 diff、失败和 LLM 提供的需求映射，由用户一次确认。冻结后任何受保护测试写入在工具执行前被策略层拦截；最终成功前重新计算哈希。

### 8.4 机制演示

1. Scripted LLM 请求受保护/越界动作，Policy Engine 在分发前拦截；
2. 首轮错误实现导致固定断言失败，mock 只有收到指定反馈指纹才返回修复动作；
3. mock 重复同一无效修改，三轮无进展后状态机确定性进入 PAUSED。

## 9. 错误处理

错误分为：

- 用户输入/配置错误：立即拒绝并提供修复命令；
- 仓库/环境错误：不交给 LLM 修复，暂停或预检失败；
- LLM 鉴权/限流/超时/协议错误：按类型有限重试，状态可恢复；
- 动作/策略错误：拒绝执行并回灌标准化观察；
- 验证失败：进入反馈闭环；
- 持久化/内部不变量错误：原子保存失败时停止，避免继续破坏状态。

所有错误具有稳定 code、用户消息、是否可重试、是否可恢复和脱敏 detail。进程退出码区分成功、暂停、用户错误、环境错误和内部失败。

## 10. 技术选型与理由

- TypeScript + Node.js >=22.12.0：与目标仓库生态一致，满足 Commander 15 的运行要求，跨平台且适合 npm 分发；
- ESM：现代 Node 包标准；
- Commander：稳定 CLI 参数/子命令；
- Zod：动作、配置和持久化数据的运行时 schema；
- Vitest：快速单测、mock 和跨平台支持；
- OpenAI 官方 JavaScript SDK或等价薄 HTTP 适配：只使用单次 Chat Completions/tool calling，不使用 agent runner；
- 可注入 CredentialStore + 平台适配器：Windows 使用 PowerShell PasswordVault，macOS 使用 `security`，Linux 使用 `secret-tool`；生产不明文降级，测试使用内存实现；
- JSON/JSONL：便于审计、恢复和不依赖数据库；
- npm package + GitHub Release：跨平台获取，满足助教允许的 Release 链接交付。

第三方依赖在实现计划中坚持最小化，README 列出许可证。

## 11. 分发设计

- npm 构件名固定为 `sentinelloop-cli`，可执行命令固定为 `sentinelloop`；若后续公开 npm registry 发生名称占用，仅 registry 发布坐标可改为用户拥有的 scope，CLI 名称和 Release 构件名保持不变；
- `npm install -g <package>` 或 `npx <package> run ...`；
- 支持 Windows、macOS、Linux，Node.js >=22.12.0；
- GitHub Actions 运行三平台测试、构建 npm tarball，并在 tag 时创建 Release；
- `.gitlab-ci.yml` 提供名为 `unit-test` 的 job；
- README 说明获取、安装、运行、系统凭据配置、平台依赖和限制；
- Release 的真实发布需要用户 GitHub 仓库及账号授权，未授权前只准备可发布构件和工作流。

## 12. 验收标准

1. 脏 Git 工作区执行 `run` 返回非零且未创建任务写入；
2. lockfile 能确定识别 npm/pnpm/yarn，冲突 lockfile 返回明确错误；
3. 测试生成阶段尝试修改生产代码被拒绝；
4. 无效红灯不能进入 FREEZE_TESTS；
5. 冻结测试修改在 Tool Dispatcher 执行前被拦截；
6. 越界路径、符号链接逃逸和未知工具被确定性拒绝；
7. 固定 Vitest/Jest/tsc/ESLint 输出产生稳定类别和指纹；
8. mock 收到指定反馈后改变动作并最终成功；
9. 同类失败连续 3 次无进展后任务进入 PAUSED；
10. 全部启用验证器在最后代码修改后通过，且基线未变，任务才 SUCCEEDED；
11. 任务在新进程中可恢复，事件序列和预算不丢失；
12. `auth status` 不显示 Key；日志、报告和错误均不含测试用 secret；
13. 一键测试无需网络和真实 LLM；
14. npm tarball 可在干净临时目录安装并运行 `--help`；
15. GitLab CI 含 `unit-test`，GitHub Actions 覆盖三平台和 Release 构建。

## 13. 测试策略

- 单元测试：状态机、schema、策略、路径、基线、解析器、指纹、进展、停机、配置、脱敏；
- 组件测试：Scripted LLM + 内存工具/存储驱动闭环；
- 集成测试：临时 TypeScript Git 仓库、真实子进程验证命令、暂停恢复；
- CLI 测试：命令、退出码、隐藏/脱敏输出；
- 分发测试：`npm pack` 后在干净目录安装执行；
- 三项机制演示：作为可重复的测试或脚本纳入 CI。

所有核心测试默认离线，真实端点只提供手动 opt-in smoke test，不进入必需 CI。

## 14. 风险与缓解

| 风险 | 缓解 |
|---|---|
| OpenAI 兼容端点行为差异 | 明确只支持 Chat Completions/tool calling 子集；契约测试 |
| 测试输出格式变化 | parser 分层、fixture 测试、未知类别保留脱敏摘要 |
| 自然语言需求验收不充分 | 测试 diff + 映射由用户冻结前确认；最终只认验证结果 |
| Keyring 原生依赖安装问题 | 预检和清晰平台文档；不明文降级 |
| 路径/symlink 绕过 | realpath、写前复验、原子写、跨平台安全测试 |
| 无进展误判 | 多指标进展、阶段推进优先、报告保留人工 resume |
| 项目规模过大 | 首版限制单仓库、单 Agent、TS/Node、无通用 shell/WebUI |
| 课程仓库/CI 口径冲突 | 同时提供 GitHub Actions 和 `.gitlab-ci.yml` |

## 15. 已确认决策与偏离

- 用户已确认阶段化状态机、模块架构和反馈闭环设计；
- 其余非关键设计按用户授权采用推荐方案；
- 不做 WebUI：依据助教后续说明，以 GitHub Release 链接替代；该偏离必须在 `AGENT_LOG.md`、README 和最终提交说明中记录；
- Release/远程 CI 的最终执行依赖用户提供或授权 GitHub/NJU Git 远程仓库。

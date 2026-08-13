# SentinelLoop 项目脉络

## 1. 项目定位

SentinelLoop 是一个面向 TypeScript/Node.js 仓库的本地优先 Coding Agent Harness。用户通过 CLI 输入自然语言功能需求，Harness 按“生成测试 → 确认红灯 → 冻结测试 → 实现 → 确定性验证 → 反馈修复”的状态机推进任务。

项目的主要贡献是确定性反馈闭环：Harness 将 test、typecheck、lint、build 的失败解析为结构化问题，比较相邻轮次是否取得进展，并通过重试预算、无进展和震荡检测决定继续或暂停。LLM 只能提出结构化动作，不能自行宣告任务成功。

## 2. 产品边界

### 首版包含

- TypeScript/Node.js >=22.12.0 项目；
- npm、pnpm、yarn 自动识别；
- 自然语言功能需求；
- Agent 驱动 TDD；
- 测试基线冻结；
- 受控文件工具和验证工具；
- 工作区范围围栏和危险动作审批；
- OpenAI Chat Completions 风格兼容端点；
- Windows Credential Manager、macOS Keychain、Linux Secret Service；
- 可恢复任务状态、事件日志和 Markdown 报告；
- npm 包与 GitHub Release 分发。

### 首版不包含

- WebUI；助教后续说明允许 Release 链接替代；
- Python、Go、Rust 等其他目标仓库；
- 任意 shell 工具；
- 多 Agent 编排；
- 云端代码托管或远程执行；
- 自动 commit、push、发布或部署；
- 完整兼容所有 OpenAI 扩展协议。

## 3. 主流程

```text
PRECHECK
  → ANALYZE_REQUIREMENT
  → GENERATE_TESTS
  → CONFIRM_RED
  → FREEZE_TESTS
  → IMPLEMENT
  → VALIDATE
       ├─ all pass → SUCCEEDED
       ├─ repairable + progress → FEEDBACK → IMPLEMENT
       ├─ protected/risky action → AWAITING_APPROVAL
       └─ stalled/budget/error → PAUSED or FAILED
```

## 4. 主要模块

1. CLI 与应用服务；
2. Task Orchestrator 和显式状态机；
3. LLM 抽象、兼容端点适配器和 Scripted Mock；
4. 结构化动作解析、Policy Engine 和 Approval Manager；
5. 文件/搜索/验证工具及 Tool Dispatcher；
6. Failure Classifier、Progress Detector 和 Feedback Engine；
7. Task Store、Memory Selector、Audit Log 和 Report Generator；
8. Credential Service、配置与包管理器/验证命令发现。

## 5. 交付路线

1. 完成规格、计划和冷启动验证；
2. 初始化隔离开发流程；
3. TDD 实现领域模型、状态机和持久化；
4. TDD 实现动作、工具和治理；
5. TDD 实现验证器、反馈分类和进展检测；
6. TDD 实现 LLM、上下文和完整循环；
7. TDD 实现 CLI、凭据、恢复和报告；
8. 完成三项机制演示；
9. 配置 npm 分发、GitHub/GitLab CI 和文档；
10. 进行全量评审、干净环境验证和 Release 准备。

## 6. 成功标准

- 无网络、无 API Key 时，mock LLM 能验证全部核心机制；
- 危险动作在工具执行前被拦截；
- 失败反馈真实进入下一轮上下文并改变 mock 的动作；
- 三轮无进展或震荡能被代码检测并暂停；
- 受保护测试未经批准不可修改；
- 只有所有启用验证器在最后一次代码修改后通过，任务才成功；
- npm 包可安装，GitHub Release 可作为最终交付链接。

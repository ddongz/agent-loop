# SentinelLoop 待完成事项表

> 本表是项目级总览；细粒度实现步骤和 commit hash 维护在 `PLAN.md`。

## A. 规约与计划

- [x] 阅读并合并通用要求与 A 类要求
- [x] 确定产品方向、目标用户和首版边界
- [x] 确定“确定性反馈闭环”为主要贡献
- [x] 完成关键设计选择与架构确认
- [x] 编写 `PROJECT_ROADMAP.md`
- [x] 编写 `SPEC.md`
- [x] 编写 `SPEC_PROCESS.md` 初稿
- [x] 使用 `writing-plans` 编写 `PLAN.md`
- [x] 使用不同类型陌生智能体冷启动 1–2 个 task
- [x] 根据冷启动证据修订 SPEC/PLAN，并记录关键 diff

## B. 工程环境与过程证据

- [ ] 初始化 Git 仓库并提交设计文档
- [ ] 建立 worktree/分支策略
- [ ] 创建并持续维护 `AGENT_LOG.md`
- [ ] 每个实现 task 使用新鲜 subagent
- [ ] 每个 task 执行 spec 合规评审和代码质量评审
- [ ] 每个 task 在 `PLAN.md` 标记状态并附 commit hash

## C. Harness 六维内核

- [ ] 决策：上下文、LLM 调用、动作解析、循环和停机
- [ ] 工具：注册、schema 校验、分发、超时和观察
- [ ] 记忆：状态、事件、反馈、决策摘要和按需选择
- [ ] 治理：路径围栏、阶段权限、测试冻结和审批
- [ ] 反馈：验证解析、失败分类、指纹、进展和震荡检测
- [ ] 配置：profile、命令发现、预算、策略和 schema 校验

## D. CLI 与产品能力

- [ ] `auth set/status/clear`
- [ ] `run <requirement>`
- [ ] `resume <task-id>`
- [ ] `status <task-id>`
- [ ] `report <task-id>`
- [ ] 脏 Git 工作区拒绝启动
- [ ] npm/pnpm/yarn 识别
- [ ] test/typecheck/lint/build 命令发现与覆盖
- [ ] 任务暂停、审批和恢复
- [ ] 最终 Markdown 报告

## E. 测试与机制演示

- [ ] 一键运行的离线单元测试
- [ ] 临时 Git 仓库集成测试
- [ ] 演示一：危险动作被治理护栏拦截
- [ ] 演示二：失败反馈改变下一步动作
- [ ] 演示三：无进展/震荡检测确定性暂停
- [ ] 红—绿—重构证据完整

## F. 安全、分发与交付

- [ ] 系统凭据管理器适配与敏感信息脱敏
- [ ] npm 包构建、全局安装和 `npx` 运行
- [ ] GitHub Actions 三平台测试与 Release 工作流
- [ ] `.gitlab-ci.yml` 包含 `unit-test` job
- [ ] README 安装、运行、安全、限制和演示章节
- [ ] 第三方许可证说明
- [ ] Git 历史 secret 扫描
- [ ] 干净环境安装与运行验证
- [ ] GitHub Release 链接（需远程仓库与账号授权）
- [ ] 最后一次 CI/CD 为 pass（需远程仓库）
- [ ] `REFLECTION.md` 由学生本人撰写 1500–2500 字

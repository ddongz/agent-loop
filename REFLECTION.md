1. 哪些技能作用最大 / 哪些形式大于实质

- 作用大：brainstorming（把"做个 harness"收敛成可测试的状态机）、writing-plans（task 颗粒度）、冷启动验证（§7.2 暴露 6 个缺陷，产出差距 100%）
- 形式大于实质：可写评审门的部分重复成本、七步流程在单人项目里的仪式感
- 你自己有判断空间：TDD 每步的红绿记录 vs 实际 debug 时间

2. TDD 是阻碍还是放大器

- 放大器证据：35 个提交的 feat/fix/docs 节奏；域契约先用失败测试锁死 8 种 Action
- 阻碍证据：AGENT_LOG.md Task 7 "controller debugging found an infinite-stream hang" —— 集成层 bug 单测测不到，得靠 demo/集成
- 结论方向：机制层放大、编排层需要集成兜底

3. subagent 能自主跑多远

- 事实：每个 task 一个新鲜 subagent，从 Task 1 到 12 基本无偏离
- 干预点：AGENT_LOG 里两次人工压缩（评审节奏、范围），和 WebUI/自然语言输入的方向修正
- 结论：短 task（2-5 分钟级）+ 明确接口 + 评审门，能跑很远

4. task 颗粒度

- 你的 PLAN：12 个 task，每 task = 一个模块 + 契约测试 + 评审门 + commit hash
- 最优颗粒度观察：能在一个会话内完成、有独立可验证产物（失败测试）的 task

5. SPEC 质量案例（必写具体案例）

- 案例现成：冷启动 agent 拿 SPEC/PLAN 写不出第一个失败测试——TaskPhase 没有权威全集、缺状态转移表、8 种 Action 字段不全
- 修订后 10 项阻塞全解，PASS

6. 最有效的 prompt/context 策略

- 冷启动指令"遇到不确定即暂停，不猜测"
- 测试冻结 + SHA-256 基线：把安全约束从 prompt 变成状态
- 指纹回灌：反馈只带观察到的 fingerprint

7. 凭据与分发迫使你想清了什么

- 系统凭据管理器、fail-closed、脱敏（假令牌测试）
- 今天的 CI 修复：本地 301 全绿 ≠ 交付可用——冷缓存 ENOTCACHED、Windows symlink 权限差异，正是"新机器从零跑"的考题
- npm 包 allowlist：156 个文件打包 vs 128 个误包含

8. 重做会改什么

- 你的真实可选项：多 worktree/PR 而非单线性分支；WebUI 偏离早确认；评审节奏不压缩；宿主组合（profile-aware CLI）早点做

9. 对 Superpowers 的批判

- 它假设"隐性上下文不存在"——冷启动证明不成立
- 它假设单人也能撑起完整 PR 评审流程——现实中靠压缩
- 它守住了纪律，但回答不了"做什么"和"做对了吗"
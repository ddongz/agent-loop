当然。下面是完整中文翻译，我会尽量保留原文的技术含义、结构和命令格式。

# SentinelLoop

SentinelLoop 是一个 **Node.js CLI（命令行工具）和 TypeScript 库**，用于在一个干净的 TypeScript Git 仓库中执行**确定性的、单智能体 TDD（测试驱动开发）循环**。

它会把模型的操作转换成经过 Schema 校验的工具调用，在真正执行之前强制检查阶段策略和路径策略，冻结已经接受的红灯测试（失败测试），并利用规范化后的验证反馈来决定是继续、暂停，还是接受当前结果。

## 架构

注入的 `TaskOrchestrator` 负责维护一个显式的阶段状态机。

在创建任务状态之前，会先执行仓库预检查和命令发现。之后，LLM 的所有操作都必须依次经过运行时 Schema、策略引擎以及结构化工具注册表；**模型不会获得任何通用 Shell 工具**。

JSON / JSONL 状态文件支持任务恢复，而验证结果指纹（fingerprint）和预算机制则用于确保停止决策具有确定性。

生产环境中的适配器可以替换为脚本化 LLM 和内存凭据，以供离线测试和演示使用。

## 要求与安装

* Node.js 22.12.0 或更高版本
* Windows、macOS 或 Linux
* 一个干净的 TypeScript / Node.js Git 仓库
* 仓库必须只使用以下一种包管理器锁文件：npm、pnpm 或 yarn
* 仓库必须提供 `test` 脚本

安装 GitHub Release 中的 tarball：

```sh
npm install -g ./sentinelloop-cli-0.1.0.tgz
sentinelloop --help
```

与 `v*` 匹配的 Release 标签会构建并附加 tarball；该工作流**不会自动发布到 npm**。

## 凭据与模型提供方

凭据绝不会降级存储到明文文件中。

可以通过以下命令管理一个具名配置档案：

```sh
sentinelloop auth set --profile default
sentinelloop auth status --profile default
sentinelloop auth clear --profile default
```

实时运行时使用 `default` 配置档案。

需要创建一个**不包含敏感信息**的配置文件：

Windows：

```text
%APPDATA%\SentinelLoop\config.json
```

macOS / Linux：

```text
$XDG_CONFIG_HOME/sentinelloop/config.json
```

通常为：

```text
~/.config/sentinelloop/config.json
```

示例内容：

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

`SENTINELLOOP_CONFIG` 环境变量可以指向其他不包含敏感信息的配置文件。

API Key 只能通过 `auth set` 保存到操作系统的凭据管理器中。

`status` 命令只会显示配置元数据，**绝不会显示 API Key**。

Windows 使用 PasswordVault，并通过非交互式 PowerShell 进行访问。

Linux 要求系统安装并解锁 `secret-tool` / libsecret 服务。

macOS 上，凭据查询和删除使用 Keychain 的 `security` 工具；但是目前 `auth set` 会采用**失败关闭（fail closed）**策略，因为使用该工具创建密钥时需要把密钥放入进程参数中。

适配器支持 **OpenAI 兼容的 Chat Completions / tool-calling 子集**，具体包括：

* 每次 completion 只允许一个结构化工具调用
* HTTP(S) Base URL
* 模型名称
* 一个显式的、用于额外非凭据请求头的允许名单

不支持：

* Agent Runner
* 各模型提供商专属的多工具调用协议
* 自动降级或自动 fallback

## 命令与生命周期

```sh
sentinelloop run "add input validation" --repository ./target-repository
sentinelloop status <task-id>
sentinelloop resume <task-id>
sentinelloop resume <task-id> --approve
sentinelloop resume <task-id> --reject "reason"
sentinelloop report <task-id>
```

`run` 会先对仓库进行预检查，之后才会创建 `.sentinelloop` 状态。

任务可能停留在以下状态：

* `AWAITING_APPROVAL`：等待批准
* `PAUSED`：已暂停
* `SUCCEEDED`：成功
* `FAILED`：失败

`resume` 会基于持久化状态继续执行任务，并且可以处理一个明确的待处理操作。

`status` 会输出当前阶段和迭代预算。

`report` 会根据状态文件和事件记录生成经过敏感信息脱敏处理的 Markdown 审计报告。

打包后的可执行程序会组合以下组件：

* 仓库预检查
* 持久化状态存储
* 基线服务
* 审批服务
* 受治理的文件工具
* 受治理的验证工具
* 反馈引擎
* OpenAI 兼容客户端

当新生成的红灯测试基线需要确认时，系统会先把对应证据展示给用户进行交互式确认，之后才会冻结该测试。

之后执行：

```sh
resume
status
report
```

等命令时，应当从目标仓库的根目录运行。

## 离线演示与开发

```sh
npm ci
npm run check
npm run demo
npm pack --dry-run
```

演示可以在**没有网络、没有 API Key**的情况下证明三个核心机制：

1. 一个受治理的操作会在真正执行之前被策略阻止；
2. 带有指纹的验证反馈可以驱动脚本化模型完成修复；
3. 当同一组失败结果连续出现三次时，任务会以确定性的方式暂停。

## 安全边界

* 模型只能访问已经注册的结构化工具，**永远不会获得通用 Shell**。
* 通过 realpath 检查和写入关联检查，把文件操作限制在目标仓库内部；`.git`、`.sentinelloop`、凭据文件和其他敏感路径都会被拒绝访问。
* 在一个有效的失败测试被接受之前，生产代码写入会被阻止。
* 被冻结的测试如果要修改，必须获得一次性的精确批准，而且该批准会与具体操作和基线绑定。
* 验证过程使用“可执行程序 + 参数数组”的形式，限制输出大小，并支持超时和进程树终止。
* 日志、错误、报告以及提供给模型的上下文都会受到长度限制并进行敏感信息脱敏。
* 仓库状态仅保存在本地 `.sentinelloop/` 目录中；**不要提交这个目录**。

## 目录结构

```text
dist/                         打包后的 JavaScript、类型声明和 source map
src/{domain,state,...}/       状态机及六个测试框架维度
scripts/mechanism-demo.ts     可复现的离线机制演示
tests/                        单元、集成、fixture 和 demo 测试
.sentinelloop/tasks/<id>/
  state.json                  通过原子替换方式更新的任务快照
  events.jsonl                只追加、经过校验的审计事件
```

## 已知限制

* 0.1 版本只面向**一个干净的 TypeScript 仓库和一个智能体**。
* 没有 WebUI。
* 没有通用 Shell。
* 没有多仓库规划器。
* 不支持自动发布 npm。

0.1 版本使用 `default` 模型提供方 / 凭据配置档案。

当新生成的红灯测试基线需要确认时，必须使用交互式终端。

红灯测试必须是一个**真实的目标测试失败**，不能是：

* 语法错误
* 依赖问题
* 测试发现问题
* 基础设施故障

默认验证顺序为：

1. test
2. typecheck
3. lint
4. build

验证会在遇到第一个失败步骤时立即停止。

密钥环是否可用以及具体行为取决于操作系统。

如前文所述，macOS 上目前会有意禁用秘密凭据的创建。

不同兼容端点对于所支持的 Chat Completions 子集可能存在差异。

真实端点检查需要手动启用，**不会作为 CI 的一部分运行**。

## 故障排查

### `DIRTY_WORKTREE`

提交或暂存目标仓库中的修改，然后重新尝试。

### `PACKAGE_MANAGER_CONFLICT`

只保留一种受支持的包管理器锁文件。

### `TEST_COMMAND_MISSING`

在 `package.json` 中添加 `test` 脚本，或者提供经过验证的覆盖配置。

### `CREDENTIAL_BACKEND_UNAVAILABLE`

安装并解锁当前平台所需的凭据服务。

SentinelLoop **不会把密钥存储到明文文件中**。

### `INVALID_CONFIG`

确保配置满足以下条件：

* Base URL 使用 HTTP(S)
* `model` 非空
* 额外 Header 名称是安全的
* 迭代次数和运行时长预算合法

任务进入暂停状态并不代表成功。

应该先查看：

```sh
sentinelloop status <task-id>
sentinelloop report <task-id>
```

处理其中记录的暂停原因，然后使用：

```sh
sentinelloop resume <task-id>
```

继续任务。

如果系统要求审批，还需要显式批准。

## 交付说明与许可证

本项目有意设计为**纯 CLI 项目**。

根据助教后续给出的澄清要求，交付方式由：

**WebUI**

替换为：

**GitHub Release 链接 + 附带的 npm tarball**

创建真实的 Release 和运行远程 CI，仍然需要一个经过授权的 GitHub / NJU Git 仓库。

当前源码树只是预先准备了这些工作流，并不代表这些远程操作已经真正执行。

最新的本地 Release 证据、验收要求映射、密钥 / Git 历史审计，以及仅作为占位符存在的 push / PR / tag 命令，都记录在：

[`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)

本地检查已经通过，但当前**没有配置远程仓库**，因此没有声称以下操作已经完成：

* 远程 CI
* Git Tag
* GitHub Release

目前剩下的唯一需要学生本人完成的验收项，是一篇**由学生本人撰写、1500–2500 个中文字符的 `REFLECTION.md`**。

为了保证该反思内容确实由学生本人创作，它被有意排除在 AI 生成的证据提交之外。

SentinelLoop 使用 **MIT License**。

直接依赖项的许可证声明记录在：

[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md)

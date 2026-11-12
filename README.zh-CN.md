# codex-Super-Agent：Codex + Antigravity 本地协作

[English](README.md) | 简体中文

SuperAgent 是一个本地、单 Worker 的开发任务编排器。它将需求登记、Antigravity 编码、逐项交付清单和交付完整性核对串联起来，最终交由用户进行手动业务验收。当前包版本为 **0.7.0**，协作协议为 **v4.0**（实现《默认逐项交付与手动验收规范 v1.0》）；任务记录在 schema 5 上支持全新交付工作流，并保持对旧版本 schema 4 任务的兼容读取。

[架构说明](docs/en/architecture.md) · [英文交付协议](docs/en/delivery-protocol.md) · [默认逐项交付与手动验收规范](docs/default-delivery-workflow.zh-CN.md) · [发布与权限补充规则](docs/release-and-permissions.md) · [验证记录](docs/VALIDATION.md)

> **交付状态的含义**：Worker 的 `READY_FOR_ACCEPTANCE` 是开发与自检完成的自报，不证明实现正确，也不代表用户已经验收。只有用户通过 `acceptance` 命令记录反馈后，需求才能进入 `ACCEPTED`。

## 协作方式与职责分工

默认协议采用清晰严格的角色分工：

- **Antigravity Worker**：承担常规开发的全部代码编写与修复工作，包括业务开发、一行小修、样式和文案调整、配置修改以及启动/功能问题修复。常规开发中 Codex 不替代编码。Worker 允许按需执行构建、Lint 或局部测试等自检（未运行如实标为 `NOT_RUN`）；自检结果绝不等于用户验收。
- **Codex 会话**：负责需求理解、任务拆分、分配稳定唯一需求 ID、定义可观察验收标准（`acceptanceCriteria`）与前置依赖（`dependsOn`），并调度 Worker；对 Worker 交付清单仅执行**完整性核对**（字段齐全、ID 覆盖、状态自洽），不设强制性 UI 交互门禁，不默认进行全面源码审查，不代替用户验收。
- **Codex 发布专责**：GitHub/Gitee 上传发布、新版本，以及为该次发布进行的版本号、更新说明、打包、签名、公证、标签、产物上传、发布验证及修复，仅由 Codex 模型执行。混合需求先拆分，发布部分不交给 agy。
- **用户**：依据交付报告中的手动测试步骤亲自在实际环境中操作验证，通过 `acceptance` 命令记录最终验收结论（`ACCEPTED` 或 `REJECTED`）。

## 核心流程

1. **登记任务（`plan`）**：登记 WorkOrder，包含稳定需求 ID、可观察验收标准（`acceptanceCriteria`）及依赖关系（`dependsOn`）。此步骤不启动编码。
2. **编码与交付（`auto`）**：调度 Antigravity 编码。Worker 输出单一合法 JSON 交付报文：
   - 首轮为全量报文 `FULL`（覆盖所有规划 ID）；
   - 后续轮次为增量报文 `DELTA`（仅包含变动项与 `oldStatus`）。
   - 每项交付包含实现说明、修改文件、自检事实（`selfChecks`）、手动测试步骤（`manualTestSteps`）、预期结果、遗留工作/问题及阻塞详情。
3. **自动推进与局部熔断**：`auto` 在同一 Worker 会话中推进未完成项；局部阻塞项标记为 `BLOCKED`，不影响无依赖关系的独立任务继续进行；同一项连续 2 轮无实质进展（`maxNoProgressRounds=2`）时熔断停止机械重试。旧参数 `maxRepairRounds` 仅作旧模式兼容，默认新模式并非全任务两轮上限。
4. **待用户验收（`AWAITING_USER_ACCEPTANCE`）**：所有可执行项就绪后，Codex 核对清单完整性，使用 `report` 导出交付与手动验收报告。
5. **用户手动验收（`acceptance`）**：用户按照测试步骤亲自操作验证，通过 `acceptance --file user-feedback.json` 记录 `ACCEPTED` 或 `REJECTED`。驳回项精准反馈给原 Worker 修复；解阻使用 `unblock`。

## 七项互斥状态

系统中每个需求项必须处于以下 7 种互斥状态之一，其总和恒等于需求总数 $N$：

| 状态 | 含义 | 权限角色 |
|---|---|---|
| `TODO` | 需求已登记，尚未开始开发 | Codex / Worker |
| `IN_PROGRESS` | 正在开发与自检中 | Worker |
| `PARTIAL` | 部分实现，尚不满足完整验收标准 | Worker |
| `READY_FOR_ACCEPTANCE` | 编码自检完成，交付字段齐全，等待用户验收 | Worker 汇报，Codex 汇总 |
| `BLOCKED` | 遇到外部依赖、权限或连续两轮无进展阻塞 | Worker 报告，Codex 登记 |
| `ACCEPTED` | 用户手动验证确认通过 | **仅用户（通过 `acceptance`）** |
| `REJECTED` | 用户手动验证未通过，指出具体问题 | **仅用户（通过 `acceptance`）** |

Worker 仅允许设置前 5 种状态；`ACCEPTED` 与 `REJECTED` 必须由用户通过 `acceptance` 命令记录，任何 Agent 均无权代替用户写入。

## 模块架构

系统保持 6 个核心模块，配合纯辅助模块 `task-store/delivery-workflow.mjs` 处理交付工作流契约：

| 模块 | 职责 |
|---|---|
| `router` | 规范 WorkOrder、目标、范围、`acceptanceCriteria`、`dependsOn` 依赖图及重试配置。 |
| `scheduler` | 管理任务状态流转（含 `AWAITING_USER_ACCEPTANCE`、`ACCEPTED`、`BLOCKED`、`CHANGES_REQUESTED`）。 |
| `worker-manager` | 以参数数组调用 Worker，解析提取 FULL / DELTA 交付报文，维护 Worker 会话。 |
| `context-manager` | 创建独立工作树，执行安全范围守门，组装精准增量返工上下文。 |
| `task-store` | schema 5 任务持久化、任务独占锁、交付历史与用户验收历史记录。 |
| `watchdog` | 监控子进程输出、超时、取消以及 POSIX 进程组退出状态。 |
| `task-store/delivery-workflow.mjs` | 纯辅助函数：负责 FULL/DELTA 校验、清单合并、七状态统计、连续无进展判定、用户反馈应用及报告渲染。 |

## 环境要求

- Node.js **22 或更高版本**；项目无运行时 npm 依赖。
- Git 仓库及至少一个已提交基线，供创建独立工作树。
- 已安装并认证的 Antigravity CLI（`agy`），支持所需 JSON 输出与会话参数。默认自动授权还需要 `--dangerously-skip-permissions`、`--sandbox` 与 `--settings`；缺少能力时明确阻塞，不静默移除隔离。
- 用于需求规划、调度及交付核对的 Codex 宿主。
- 当前流程在 macOS 上实跑，原生 Windows 不受支持。

## 安装与初次检查

```bash
git clone https://github.com/SuAries/codex-Super-Agent.git
cd codex-Super-Agent
node cli.mjs help
node scripts/install.mjs
```

默认安装到 `~/.codex/super-agent`。如需更新已存在的目录，使用 `--force`：

```bash
node scripts/install.mjs --dest /absolute/path/to/super-agent --force
```

安装器绝不会自动修改或覆盖您的 `AGENTS.md`。

### 指令模板

- [全局就绪指令模板](templates/AGENTS.global.zh-CN.md)：适合在用户授权备份后作为全局默认规则使用。
- [双语工作流模板](templates/)：提供[中文版](templates/AGENTS.zh-CN.md)与[英文版](templates/AGENTS.en.md)，可供手动合并至项目指令。

## 快速开始

### 1. 编写工作单

参考 [examples/workorder.example.json](examples/workorder.example.json) 编写工作单：

```bash
node ~/.codex/super-agent/cli.mjs plan --file /absolute/path/to/workorder.json
```

### 发布路由与 Worker 权限

发布工作单显式设置 `taskKind: "RELEASE"`，或在 `plan` 使用 `--task-kind RELEASE`。发布任务的 `run`/`auto` 在派发 Worker 前返回 `CODEX_ONLY`，交由当前 Codex 会话执行已授权发布；CLI 不自动启动 Codex 模型或执行发布。目标和需求文字识别仅用于防误派，不能替代规划时显式分类。

常规任务默认 `agyPermissionPolicy: "AUTO_APPROVE"`：在已授权任务的隔离工作树内，对当前 agy CLI 会话的工具请求自动批准，包括文件写入和命令执行；仍保留终端隔离。默认同意不扩大任务范围、不授权 agy 发布、不允许泄露凭据，也不修改全局 agy、系统或 Codex 审批设置。平台强制确认、管理员规则及显式拒绝仍有效。如需普通审批，设置 `agyPermissionPolicy: "STANDARD"` 或 `plan --agy-permission-policy STANDARD`。派发前阅读[完整双语补充规则](docs/release-and-permissions.md)。

### 2. 调度 Worker 编码

```bash
node ~/.codex/super-agent/cli.mjs auto --id <task-id>
```

Worker 输出首轮 `FULL` 或后续 `DELTA` 报文，`auto` 自动在同一会话中推进，直到字段齐全且无未完成项。

### 3. 查看交付并导出报告

```bash
node ~/.codex/super-agent/cli.mjs status --id <task-id>
node ~/.codex/super-agent/cli.mjs inspect --id <task-id> --delivery
node ~/.codex/super-agent/cli.mjs report --id <task-id> --format markdown --file delivery-report.md
```

导出的交付报告呈现 7 状态统计（总和恒为 $N$）、逐项手动测试步骤与阻塞详情。参见 [examples/delivery-report.example.md](examples/delivery-report.example.md)。

### 4. 用户手动验收

用户按照手动测试步骤操作验证后，通过 `acceptance` 提交验收决定：

```bash
node ~/.codex/super-agent/cli.mjs acceptance --id <task-id> --file /absolute/path/to/user-feedback.json
```

- 全部项 `ACCEPTED` 时，任务最终完成；
- 存在 `REJECTED` 项时，携带具体反馈重新交由原 Worker 修复；
- 具备解阻条件后，使用 `unblock` 恢复任务：
  ```bash
  node ~/.codex/super-agent/cli.mjs unblock --id <task-id> --requirement-id REQ-002 --reason "环境变量已配置"
  ```

## 命令一览

| 命令 | 用途 |
| --- | --- |
| `doctor` | 检查模块、接口及路径条件；不调用模型。 |
| `plan` | 从参数或 `--file` 登记工作单；命令行工作单支持 `--task-kind DEVELOPMENT\|RELEASE` 与 `--agy-permission-policy AUTO_APPROVE\|STANDARD`。 |
| `run` / `auto` | 常规任务单次编码 / 自动推进；发布任务返回 `CODEX_ONLY` 交接。 |
| `inspect --delivery` | 查看逐项交付及交接信息。 |
| `report` | 导出交付与手动验收报告（Markdown 或 JSON）。 |
| `acceptance` | 录入用户手动验收结论（`ACCEPTED` / `REJECTED`）。 |
| `unblock` | 解除需求阻塞并重置为可处理状态。 |
| `status` / `list` | 查看任务状态 / 任务列表。 |
| `recover` | 确认关联进程退出后安全恢复孤儿锁。 |

## 历史兼容与可选审查

- **旧任务兼容**：旧 schema 4 任务及配置为 `CODEX_FUNCTIONAL_CHECK` / `CODEX_STARTUP_CHECK` 的任务继续有效。历史上的 `PASS` 或 `OPENED` 记录保持原有语义，绝不自动升级为新协议的用户 `ACCEPTED`。详见[历史功能确认规范](docs/逐项交付与功能确认规范.md)与[启动打开验证规范](docs/启动打开验证规范.md)。
- **可选源码审查**：可选源码审查（`inspect --code-review`、`review-agent`、`review --file`）保持独立可选；仅在用户明确要求时使用，默认交付流程绝不调用。详见[代码审查规范](docs/Codex智能代码审查规范.md)。

## 文档与社区

- [默认逐项交付与手动验收规范](docs/default-delivery-workflow.zh-CN.md)
- [架构设计](docs/en/architecture.md)、[英文交付协议](docs/en/delivery-protocol.md)与[验证记录](docs/VALIDATION.md)
- [贡献指南](CONTRIBUTING.zh-CN.md)、[安全策略](SECURITY.md)、[更新记录](CHANGELOG.md)与[发布说明](docs/RELEASING.md)
- [MIT 许可证](LICENSE)

`package.json` 保留 `private: true` 仅用于防止误发 npm，不影响按 MIT 许可证开源、修改或分发源码。

# SuperAgent 工作流模板 — 协议 4.0 / 规范 v1.0

此文件供 Codex 会话选择采用。可手动合并到自己的项目或用户级 `AGENTS.md`，保留已有指令。默认安装位置为 `~/.codex/super-agent`；自定义位置须同步修改 CLI 路径。程序安装器不会自动安装或覆盖这些规则。

## 分工

- **常规开发编码严格由 Antigravity 承担**：包括业务开发、小修改、样式文案调整、配置修改以及启动/功能问题修复。**GitHub/Gitee 发布、新版本及为该次发布进行的版本号、更新说明、打包、签名、公证、标签、产物上传、发布验证与修复仅由 Codex 模型执行**。混合需求先拆分，发布部分不派给 agy。用户明确指定的分工优先。
- **常规开发中 Codex 负责规划、调度与交付清单完整性核对**：不进行全面源码审查，不设强制性 Codex UI 操作卡点；将审核限定为交付字段完整性、ID 覆盖与状态自洽核对。
- **用户执行最终手动验收**：用户依据交付清单中的手动测试步骤亲自操作验证，通过 `acceptance` 命令记录最终结论。Worker 自检或声称完成绝对不等于用户验收。
- **Worker 允许按需自检**：agy 可在必要时执行构建、Lint 或局部测试等自检（遵守用户明示约束，未执行如实标为 `NOT_RUN`）。默认不强制全仓自动化测试套件或 CI。

## 顺序

1. 确认范围、约束、Git 基线与稳定需求 ID，形成包含可观察验收标准（`acceptanceCriteria`）与前置依赖（`dependsOn`）的 WorkOrder；发布项显式使用 `taskKind: "RELEASE"`，常规项为 `DEVELOPMENT`。
2. 优先使用 `node ~/.codex/super-agent/cli.mjs`。`plan` 登记任务；常规任务的 `auto` 调度 Worker 在同一会话中推进。发布任务的 `run`/`auto` 返回 `CODEX_ONLY` 交接，由当前 Codex 会话处理，不自动启动其他模型或发布。
3. Worker 输出规范的单一结构化 JSON（首轮 `FULL` 全量覆盖所有 ID，后续 `DELTA` 仅回报变更项与 `oldStatus`）。
4. 状态使用统一的七项状态（`TODO`、`IN_PROGRESS`、`PARTIAL`、`READY_FOR_ACCEPTANCE`、`BLOCKED`、`ACCEPTED`、`REJECTED`）。Worker 仅可设置前五项；自检结果不代表用户验收。
5. 局部受阻项标记为 `BLOCKED`，不阻塞无依赖关系的独立需求；同一项或同一失败点连续 2 轮无实质进展时熔断停止机械重试。
6. 达到就绪后任务进入 `AWAITING_USER_ACCEPTANCE`。Codex 执行完整性核对，导出交付与手动验收报告供用户亲自测试。
7. 用户手动测试后，使用 `acceptance --id TASK_ID --file user-feedback.json` 记录 `ACCEPTED` 或 `REJECTED` 明确反馈。被驳回项由原 Worker 会话精准返工修复；解除阻塞使用 `unblock`。

## 边界

- 严禁编造自检通过、界面操作或用户验收；未执行的检查必须如实注明。
- 常规任务默认 `agyPermissionPolicy: "AUTO_APPROVE"`：已授权任务范围内的 agy 工具权限请求默认允许，以会话级自动批准配合终端隔离执行；可设为 `STANDARD` 收紧。保留平台强制确认、管理员/显式拒绝、任务范围与敏感数据保护；不修改全局 agy、系统或 Codex 审批设置。
- 严格遵循 Git 工作树隔离，以参数数组执行外部 CLI，不复制凭据；平台拒绝时如实报告，不通过改权限绕过。
- 保留未提交修改与无关代码，不擅自 commit、push、merge 或部署。
- 最新发布与权限补充规则见 `~/.codex/super-agent/docs/release-and-permissions.md`，优先于原规范的一般分工；基础交付规范见 `~/.codex/super-agent/docs/default-delivery-workflow.zh-CN.md`。旧版 UI 功能确认与显式源码审查作为可选历史模式保留。

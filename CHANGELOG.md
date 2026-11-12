# Changelog

## Unreleased — release ownership and session permission policy

- Reserve GitHub/Gitee publication, new version releases, and their release preparation/verification/fixes for Codex models only; release tasks return `CODEX_ONLY` before Antigravity dispatch. Mixed requests are split into development and release work.
- Add explicit `taskKind` (`DEVELOPMENT` / `RELEASE`) and session `agyPermissionPolicy` (`AUTO_APPROVE` / `STANDARD`) settings. Routine development defaults to automatic Worker tool approval with terminal isolation; platform/admin restrictions, explicit denials, task scope, credentials protection, and release ownership still apply.
- Synchronize bilingual documentation and instruction templates with the [policy supplement](docs/release-and-permissions.md), preserving the supplied canonical workflow document unchanged. This policy update does not publish a version or change Engine 0.7.0 / Protocol 4.0.

中文：GitHub/Gitee 发布、新版本及该次发布的准备、验证和修复仅由 Codex 模型执行；常规开发仍由 agy 完成，并默认在隔离工作树的 CLI 会话内自动批准工具权限。可用 `STANDARD` 收紧审批；不修改全局 CLI、系统或 Codex 权限。此处是未发布规则更新。

## Engine 0.7.0 — Collaboration Protocol 4.0 (Default Delivery Workflow v1.0)

- **Default Delivery Workflow**: Implement Default Delivery and Manual Acceptance Policy v1.0 as the global default (`reviewMode: "CODEX_DELIVERY_CHECK"`).
- **Strict Role Separation**:
  - Antigravity Worker performs all coding work (features, small edits, copy, styling, configuration, startup fixes, and defect repairs).
  - Codex performs task planning, stable requirement ID assignment, observable `acceptanceCriteria` definitions, dependency tracking (`dependsOn`), and delivery checklist completeness checks only. No mandatory UI interaction gate or full-source review in default mode.
  - User performs final manual testing and records acceptance decisions via `acceptance`.
- **Seven Canonical Mutually-Exclusive Statuses**: `TODO`, `IN_PROGRESS`, `PARTIAL`, `READY_FOR_ACCEPTANCE`, `BLOCKED`, `ACCEPTED`, `REJECTED`. The Worker may set only the first five; `ACCEPTED` and `REJECTED` are reserved exclusively for explicit user feedback.
- **FULL and DELTA Worker Reports**: Initial turn returns `FULL` report covering all planned requirement IDs; subsequent repair turns return `DELTA` reports containing only changed items with `oldStatus`.
- **Worker Self-Checks**: Worker may run local build, lint, or targeted unit tests as needed, reporting results truthfully in `selfChecks` (`PASSED`, `FAILED`, `NOT_RUN`). Unrun checks must be honestly reported. Self-checks never substitute for user acceptance.
- **Partial Blockers and No-Progress 2 Policy**: A blocked requirement does not block independent tasks. Consecutive completion attempts on the same item without substantive progress (default `maxNoProgressRounds=2`) stops retries on that item and marks it `BLOCKED` with clear reason, impact, attempted actions, required assistance, and resume conditions.
- **New CLI Commands**:
  - `acceptance --id ID --file user-feedback.json`: Record user manual acceptance decisions.
  - `unblock --id ID --requirement-id REQ-ID --reason TEXT`: Reset a blocked requirement to resume work.
  - `report --id ID [--format markdown|json] [--file FILE]`: Export human-readable delivery and acceptance reports.
- **Architecture & Helpers**: Pure helper module `task-store/delivery-workflow.mjs` handles report validation, delta merging, progress tracking, and report generation; covered by `test/delivery-workflow.test.mjs`.
- **Templates & Instructions**: Added deploy-ready `templates/AGENTS.global.zh-CN.md` pointing to canonical documentation; updated public bilingual templates.
- **Legacy Compatibility**: Schema 4 tasks, `CODEX_FUNCTIONAL_CHECK`, and `CODEX_STARTUP_CHECK` retain their original semantics; historical `PASS` or `OPENED` observations are never automatically converted into user `ACCEPTED`.

## Local Engine 0.6.0 — Collaboration Protocol 3.3

- Require per-requirement `IMPLEMENTED / INCOMPLETE / BLOCKED` Worker delivery reports.
- Continue incomplete delivery in the same Worker conversation within a shared bounded repair budget.
- Record current Codex functional confirmation separately from Worker claims and user final acceptance.
- Preserve legacy startup-only records without upgrading them to functional confirmation.
- Keep independent full-source Reviewer tools opt-in.

## 中文说明

0.7.0 版本全面落地《默认逐项交付与手动验收规范 v1.0》（协议 4.0）：
- 明确分工：Worker 承担全部编码，Codex 仅做规划与交付完整性核对，用户进行最终手动业务验收；
- 统一七项互斥需求状态（`TODO`, `IN_PROGRESS`, `PARTIAL`, `READY_FOR_ACCEPTANCE`, `BLOCKED`, `ACCEPTED`, `REJECTED`），Worker 仅可填前 5 种，后两种仅限用户通过 `acceptance` 录入；
- 支持首轮 `FULL` 与后续增量 `DELTA` 交付报文，Worker 允许按需执行自检（`NOT_RUN` 如实上报）；
- 局部受阻不阻断独立项，两轮无实质进展熔断停止该项机械重试；
- 新增 `acceptance`、`unblock`、`report` 命令，提供纯辅助模块 `task-store/delivery-workflow.mjs` 与全局指令模板 `templates/AGENTS.global.zh-CN.md`；
- 兼容旧版 schema 4 任务与 `CODEX_FUNCTIONAL_CHECK` / `CODEX_STARTUP_CHECK`，历史通过结论绝不篡改为用户验收。

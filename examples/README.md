# Example data / 示例数据

These files document the data formats used in SuperAgent 0.7.0 / Protocol 4.0 (Default Delivery and Manual Acceptance Policy v1.0). They do not run tests, call models, or prove that a feature works.

这些文件仅说明 SuperAgent 0.7.0 / 协议 4.0（默认逐项交付与手动验收规范 v1.0）中的数据格式，不运行测试、不调用模型，也不代表功能已经验证或已由用户验收。

| File / 文件 | Role & Use / 角色与用途 |
|---|---|
| `workorder.example.json` | WorkOrder definition: repo, goal, scope, constraints, and `acceptance` entries with observable `acceptanceCriteria` and `dependsOn` dependencies. / 工作单定义：包含可观察验收标准与前置依赖。 |
| `worker-delivery.full.example.json` | Initial turn FULL report (`reportKind: "FULL"`, `baseRevision: 0`): covers every planned requirement ID once with mandatory fields, honest self-checks, and manual test steps. / 首轮全量交付清单示例。 |
| `worker-delivery.delta.example.json` | Subsequent repair turn DELTA report (`reportKind: "DELTA"`, `baseRevision: N`): includes only changed items with `oldStatus` and updated test steps. / 后续增量交付清单示例。 |
| `worker-delivery.example.json` | Current canonical FULL delivery example showing truthful per-requirement reporting with partial implementation. / 当前标准全量交付示例。 |
| `user-feedback.example.json` | User manual acceptance feedback submitted via `acceptance --file`: records explicit `ACCEPTED` or `REJECTED` user decisions. / 用户手动验收反馈示例。 |
| `delivery-report.example.md` | Human-readable delivery report exported via `report`: shows seven mutually-exclusive status counts summing to $N$, manual test steps, and blocker records. / 导出的 Markdown 交付与验收报告示例。 |
| `functional-check.example.json` | **Legacy / Explicit Optional**: Format for the optional `CODEX_FUNCTIONAL_CHECK` mode (protocol 3.3). Not used in the default protocol 4.0 workflow. / 历史兼容/显式可选功能确认报告示例。 |

## Seven Mutually-Exclusive Statuses / 七项互斥状态

In SuperAgent 0.7.0, every requirement item is in exactly one of seven mutually-exclusive states:
1. `TODO`: Planned, not yet implemented.
2. `IN_PROGRESS`: Implementation in progress.
3. `PARTIAL`: Partially implemented; missing criteria.
4. `READY_FOR_ACCEPTANCE`: Worker reports coding/self-checks complete with all required fields; waiting for user.
5. `BLOCKED`: Blocked by external dependency, permission, or no-progress 2 rounds limit.
6. `ACCEPTED`: **User only**: Explicitly confirmed as passed by human user.
7. `REJECTED`: **User only**: Explicitly rejected by human user with defect feedback.

The sum of all seven status counts must equal the total number of planned requirements $N$. A Worker may only report the first five statuses. Only explicit user feedback via `acceptance` can set `ACCEPTED` or `REJECTED`.

## Sequential 3-Item Example Flow / 三项连贯示例流程

The example files demonstrate a single coherent progression across three synthetic requirements (`REQ-001`, `REQ-002`, `REQ-003`):
1. `workorder.example.json`: Registers `REQ-001` (increment), `REQ-002` (reset, depends on `REQ-001`), and `REQ-003` (cloud export, depends on `REQ-001`), with `maxNoProgressRounds: 2`. Legacy `maxRepairRounds` is supported only for legacy modes; the default protocol tracks per-item progress rather than capping total task rounds at two.
2. `worker-delivery.full.example.json` (and `worker-delivery.example.json`): Turn 1 (`reportKind: "FULL"`, `baseRevision: 0`). `REQ-001` is `READY_FOR_ACCEPTANCE` (criteria `[0, 1]`), `REQ-002` is `PARTIAL` (criterion `[0]`), and `REQ-003` is `BLOCKED` (missing test API key credentials).
3. `worker-delivery.delta.example.json`: Turn 2 (`reportKind: "DELTA"`, `baseRevision: 1`). Contains only changed item `REQ-002` transitioning from `oldStatus: "PARTIAL"` to `READY_FOR_ACCEPTANCE` (criteria `[0, 1]`).
4. `user-feedback.example.json`: User manual acceptance via `acceptance --file` at `checklistRevision: 2`, accepting `REQ-001` and `REQ-002` while `REQ-003` remains blocked.
5. `delivery-report.example.md`: Exported markdown report displaying 7 mutually-exclusive status counts summing to $N=3$ (2 ACCEPTED, 1 BLOCKED, 0 in other states).

All examples are synthetic format references and do not represent actual user acceptance or live credentials.

## Synthetic Identifiers / 合成标识

All identifiers (`00000000-0000-4000-8000-000000000001`, `REQ-001`, etc.) and paths are synthetic format demonstrations. Never copy example files into a production task without populating genuine task IDs, code locations, and actual observations.

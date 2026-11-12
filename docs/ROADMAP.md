# Roadmap / 路线图

These are proposals for discussion, not shipped features, delivery commitments, or a release schedule. Priorities depend on contributors and feedback.

- Collect reproducible platform evidence, including Linux, before making support claims; native Windows is currently unsupported.
- Document and verify external CLI versions and compatibility as their interfaces change.
- Improve CLI message localization and keep English/Chinese documentation aligned across protocol 4.0 and future versions.
- Explore adapters for other coding workers while preserving explicit permissions and clear responsibility boundaries.
- Improve local observability and recovery guidance without exposing sensitive task data or treating cumulative counters as additive.
- Expand test coverage (such as `test/delivery-workflow.test.mjs` and optional CI) with explicit maintainer and user consent, covering realistic process and worktree failure cases.

以上均为讨论提议，不代表已实现、承诺交付或固定排期：

- 收集包括 Linux 在内的可复现平台证据，再决定支持声明；目前不支持原生 Windows。
- 随外部 CLI 接口变化，记录并验证版本兼容性。
- 改进 CLI 提示的多语言支持，并保持协议 4.0 及后续版本的中英文文档同步。
- 探索其他编码 Worker 适配器，同时保留明确的权限与责任边界。
- 改进本地可观察性和恢复指引，避免泄露任务数据或累加会话累计计数。
- 在维护者及用户明确同意的前提下，完善测试用例（如 `test/delivery-workflow.test.mjs` 与可选 CI），覆盖实际进程与工作树故障。

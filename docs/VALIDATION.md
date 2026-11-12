# Validation record / 验证记录

This document distinguishes documentation authoring, runtime task self-checks, and user manual acceptance. It does not claim that unrun code paths, platforms, or external CLI versions have been verified.

本文区分文档编写、运行分任务自检与用户最终手动验收，不声称未运行的代码分支、平台或外部 CLI 版本均已验证。

## Current snapshot: Engine 0.7.0 / Protocol 4.0

- Engine: `0.7.0`; workflow protocol: `4.0` (implementing Default Delivery Workflow Policy v1.0).
- Core modules: 6 local modules (`router`, `scheduler`, `worker-manager`, `context-manager`, `task-store`, `watchdog`) plus pure helper `task-store/delivery-workflow.mjs` and test suite `test/delivery-workflow.test.mjs`.
- Documentation and templates: Authored by Antigravity (Antigravity Coding Worker). The documentation subtask did not run terminal self-check commands and did not invoke additional external model CLIs, using built-in file tools directly in the workspace.
- Runtime subtask self-check record (executed under explicit user authorization for two commands within the terminal sandbox):
  - `node cli.mjs help`: Succeeded (exit code 0).
  - `node --test test/delivery-workflow.test.mjs`: First run had 17 test cases (16 passed, 1 failed); after bug fix by the worker, second run had 17 test cases (17 passed, 0 failed).
  - Codex verified these test output numbers from the original execution tool records; Codex did not re-run tests and did not perform code quality review.
  - Worker self-checks are not user manual acceptance. No unverified platform or terminal Node versions are asserted.

## Historical Packaging Verification (0.6.0 / Protocol 3.3) — 2026-11-11

Observed on macOS with Node.js `v26.13.0` and Git `2.56.0`:

| Check | Actual result |
|---|---|
| Source `node cli.mjs help` | Exited 0 and displayed protocol 3.3 commands. |
| `node scripts/install.mjs --help` | Exited 0 and displayed the offline installation options. |
| Fresh installation to a separate temporary directory | Completed with the fixed runtime manifest; no account or global instruction file was changed. |
| Installed `node cli.mjs help` | Exited 0. |
| Installed `node cli.mjs list --state-root <separate-temporary-directory>` | Exited 0 with an empty task list, exercising import of the six default modules without calling a model. |
| Reusing the existing temporary install destination without `--force` | Refused with exit code 1 and an explicit existing-destination message. |
| `npm pack --dry-run --ignore-scripts` | Local source package enumeration completed; no lifecycle script or publication was performed. |
| Local Markdown file links | Referenced local targets were present. |
| Original `.mjs` source and existing global instructions | Byte comparisons found no changes to the original runtime files or the active global instructions. |

## Source-publication preparation — 2026-11-12

Observed on macOS with Node.js `v22.23.4` and Git `2.56.1` by the Codex publication session:

- Source `node cli.mjs help`: exited 0 and displayed Engine 0.7.0 / Protocol 4.0 commands.
- Fresh offline installation to a separate temporary directory: exited 0 with all 49 runtime-manifest files present.
- Installed `node cli.mjs help`: exited 0. No model CLI, account setup, or global instruction changes were involved.
- Publication scope: 52 source, documentation, template, example, and repository-support files; local runtime state and system files are excluded.
- Relative Markdown file targets were present. Automated tests, live Worker execution, and user manual acceptance were not performed by this publication session.

中文：本次发布准备实际完成源码帮助命令、临时目录离线安装与安装后帮助命令检查，均正常退出；核对了 52 个待公开文件和 Markdown 本地链接。未运行自动化测试、真实 Worker 或用户手动业务验收，未修改账号及全局指令配置。

## Limits of source-preparation verification

- No new external model CLI was invoked during the documentation subtask; file operations were performed directly.
- Linux runtime, native Windows, third-party CLI-version combinations, and concurrent installation races are not established by local self-checks.
- The optional independent full-source Reviewer remains version/capability dependent and is not validated by this task.
- The earlier source-preparation work did not create a GitHub repository, upload or push source, create tags or releases, or publish to npm. Publication is a separate maintainer action; the checks above do not establish its outcome.

## 中文说明

当前版本为 `0.7.0` 引擎与 `4.0` 协议，全面落地《默认逐项交付与手动验收规范 v1.0》：
1. **文档编写主体与自检事实**：全部文档与模板由 Antigravity 编码完成。文档子任务未执行终端自检命令，未再次调用其他模型 CLI，所有修改均使用内置文件工具直接完成。
2. **运行分任务真实自检记录**：在用户仅本次两条命令授权及 terminal sandbox 环境下：
   - `node cli.mjs help`：执行成功（退出码 0）；
   - `node --test test/delivery-workflow.test.mjs`：首次运行 17 项测试中 16 项通过、1 项失败；经修复后再次运行，17 项测试全部通过（17 通过，0 失败）。
   - Codex 仅从原始工具记录核对上述数字事实，未重复运行测试，未进行全仓代码质量审查。
3. **验收边界**：上述自检结果仅作为 Worker 自检记录，绝不代表用户最终手动业务验收。不虚构测试终端 Node 版本或未运行平台的兼容性。

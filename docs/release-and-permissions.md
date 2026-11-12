# 发布与权限补充规则 / Release and permission supplement

适用于 Engine 0.7.0 / Protocol 4.0。此补充规则反映用户最新分工与权限要求；它补充[原始逐项交付规范](default-delivery-workflow.zh-CN.md)，并在发布职责与权限处理存在冲突时优先适用。原始规范文件保持原样；稳定 ID、FULL/DELTA、七项互斥状态、诚实自检、局部阻塞及用户最终手动验收边界继续有效。

## 中文

### 发布工作只使用 Codex 模型

以下需求由当前 Codex 会话规划并执行，不派给 Antigravity，也不将发布阶段交给其他模型：

- GitHub 或 Gitee 的仓库上传、源码推送、公开发布与版本 Release；
- 发布新版本、更新已发布版本，以及为该次发布进行的版本号、更新说明、标签、打包、签名、公证、产物上传；
- 该次发布的目标核对、发布后验证和发布问题修复。

常规产品开发、小修改、样式、文案、普通配置、启动和功能修复仍交给 agy。一般开发中的构建自检不因此变成发布任务；为实际分发准备产物属于发布工作。混合需求先拆分为常规开发与发布两部分，发布部分始终交给 Codex。发布任务中的代码、脚本或配置修复也由 Codex 完成。

规划时显式设置 `taskKind: "RELEASE"`；常规任务为 `DEVELOPMENT`。CLI 可用：

```sh
node ~/.codex/super-agent/cli.mjs plan \
  --repo /absolute/path/to/project \
  --goal "Publish the approved version to the authorized repository" \
  --scope "docs/**" \
  --task-kind RELEASE
```

`run` / `auto` 对发布任务返回 `CODEX_ONLY` 交接信息，供当前 Codex 会话继续。它不会启动 agy、自动启动 Codex CLI、创建 Release 或上传任何内容。对目标和需求文字的识别只是防误派的补充措施；Codex 仍须显式分类。旧任务在派发前也重新检查发布意图；混合目标交回 Codex 拆分。

只在用户已授权的目标、内容和版本范围内执行发布；已有明确授权时继续完成该范围工作，不重复询问。目标或内容缺失时先准备可核对的成果，再请求必需信息。权限默认允许不等于授权发布到任意账号或目的地。本次规则更新没有执行 GitHub/Gitee 发布，也没有创建新版本。

### agy 工具权限默认允许

常规工作单默认 `agyPermissionPolicy: "AUTO_APPROVE"`。在用户已经授权的任务和数据范围内，SuperAgent 对当前 agy CLI 会话的工具权限请求默认同意，包括文件写入和命令执行，不逐项重复询问。自动批准只用于受控的独立 Git 工作树；同时启用终端隔离，并明确禁止非工作区访问。

当前调用参数为：

```text
--mode accept-edits
--dangerously-skip-permissions
--sandbox
--settings {"allowNonWorkspaceAccess":false}
```

这些参数以固定参数数组传给 CLI，不由 shell 拼接执行。它们只影响该次受控 agy 会话，不改写全局 agy 配置、系统权限或 Codex 审批设置。若 CLI 缺少所需自动批准、隔离或会话设置能力，任务明确报权限能力阻塞，不静默移除隔离或降低约束。

需要保留普通审批时，在工作单设置 `agyPermissionPolicy: "STANDARD"`，或为命令行工作单使用：

```sh
node ~/.codex/super-agent/cli.mjs plan \
  --repo /absolute/path/to/project \
  --goal "Implement the approved feature" \
  --scope "src/**" \
  --agy-permission-policy STANDARD
```

默认同意不覆盖平台强制确认、管理员限制、显式拒绝、任务 scope、敏感数据保护、进程与任务锁，以及 Codex 发布专责。遇到真实拒绝时保留成果并如实报告；不得通过修改全局权限、移除隔离或换路径绕过。不要读取或传输密钥、`.env` 凭据、账号配置和与任务无关的私有数据。

### 交付和验收仍分开记录

常规开发中 Codex 只规划、调度及核对清单完整性，不默认全面审查代码或设置强制 UI 操作门禁；agy 如实记录必要自检及 `NOT_RUN`；用户依据步骤亲自手动验收。`ACCEPTED` / `REJECTED` 只能依据用户明确原始反馈登记。发布执行、Worker 自检、命令正常启动均不能替代用户业务验收。

## English

This supplement records the latest role and permission policy for Engine 0.7.0 / Protocol 4.0. It takes precedence over the base workflow's general role split where release ownership or permission handling differs. The supplied [canonical workflow](default-delivery-workflow.zh-CN.md) remains unchanged. Stable IDs, FULL/DELTA, the seven mutually exclusive statuses, truthful self-checks, partial blockers, and final user manual acceptance still apply.

### Codex models own publication and releases

Only the current Codex session handles GitHub/Gitee repository uploads, source pushes, public publication, version releases, and their version metadata, release notes, tags, packaging, signing, notarization, artifact uploads, release verification, and release fixes. This includes code, scripts, or configuration changed for that release. Never dispatch this work to Antigravity or another model.

Routine product development, small edits, style/copy changes, ordinary configuration, startup fixes, and functional repairs remain Antigravity-owned. Routine build self-checks are development; preparing artifacts for actual distribution is release work. Split mixed requests before dispatch and keep their release portion with Codex.

Explicitly set `taskKind: "RELEASE"` or `plan --task-kind RELEASE`; ordinary tasks use `DEVELOPMENT`. `run` and `auto` return a `CODEX_ONLY` handoff before Worker dispatch. They do not launch agy, launch a Codex CLI, publish, tag, or upload anything automatically. Wording detection in goals and requirements is an additional safeguard, not a replacement for explicit task classification. Existing records are checked again before dispatch; mixed goals are handed back to Codex for splitting.

Publish only the destination, contents, and version the user authorized. Existing explicit authorization should be acted on without repeatedly requesting it. Prepare reviewable artifacts before requesting any missing destination or required decision. Default Worker permission approval does not authorize an arbitrary publication target. This policy update has not published a repository or released a new version.

### Worker tool requests default to approval

Routine work orders default to `agyPermissionPolicy: "AUTO_APPROVE"`. The user's approved task/data scope preauthorizes tool requests for that controlled CLI session, including writes and command execution. Auto-approval is restricted to the isolated Git worktree, with terminal isolation and non-workspace access disabled. The argument-array launch uses:

```text
--mode accept-edits
--dangerously-skip-permissions
--sandbox
--settings {"allowNonWorkspaceAccess":false}
```

This changes only the managed agy session. It does not edit global agy configuration, operating-system permissions, or Codex approval settings. A CLI missing the required permission/isolation/settings capabilities produces an explicit capability blocker; isolation is never silently removed. To retain normal approvals, use `agyPermissionPolicy: "STANDARD"` or `plan --agy-permission-policy STANDARD`.

Platform-required confirmation, administrator restrictions, explicit denials, task scope, credentials protection, process/lock safeguards, and Codex-only release ownership remain in force. Preserve work and report a real denial; do not change global controls, remove isolation, or switch paths to circumvent it. Never read or transmit secret keys, `.env` credentials, account configuration, or unrelated private data.

### Preserve the acceptance boundary

For routine development, Codex plans, coordinates, and checks checklist completeness without a default full-source review or mandatory UI gate. Antigravity reports actual self-checks and `NOT_RUN` honestly. Only explicit original user feedback may be recorded as `ACCEPTED` or `REJECTED`. Release execution, Worker self-checks, and successful command startup are separate facts from user business acceptance.

## Vendor reference / 厂商参考

The session permission flags and their limits are described by [Antigravity agent settings](https://antigravity.google/docs/agent-settings) and [Antigravity ACP permissions](https://antigravity.google/docs/ide/extensions/acp). Available flags are also checked against the installed CLI help before use. These references describe the vendor controls; they do not prove that every command will be allowed on every machine.

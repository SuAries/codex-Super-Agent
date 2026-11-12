# SuperAgent

A local, single-worker orchestrator for a Codex + Antigravity development workflow. SuperAgent records a scoped work order, dispatches an Antigravity coding session, tracks a requirement-by-requirement delivery checklist, and presents the result for Codex delivery completeness verification and final manual acceptance by the user.

[简体中文](README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

Package version **0.7.0** · collaboration protocol **4.0** (Default Delivery Workflow Policy v1.0) · Node.js **22 or later**

[Architecture](docs/en/architecture.md) · [Delivery protocol](docs/en/delivery-protocol.md) · [Canonical policy (ZH)](docs/default-delivery-workflow.zh-CN.md) · [Release & permission policy](docs/release-and-permissions.md) · [Validation record](docs/VALIDATION.md)

> A Worker marking an item `READY_FOR_ACCEPTANCE` is a claim of implementation readiness, not evidence that the feature is correct or that the user has accepted it. Only explicit user feedback via `acceptance` can mark a requirement `ACCEPTED`.

## What it does

SuperAgent provides a repeatable handoff between a planning/coordination session and an Antigravity coding Worker. The default protocol (protocol 4.0, implementing Default Delivery Workflow policy v1.0) defines strict responsibilities:

- **Antigravity Worker**: Writes routine development code and fixes, including small copy, style, configuration, startup, and functional fixes. The Worker is permitted to execute as-needed local self-checks (such as builds, linters, and unit tests) when useful; unrun checks are honestly marked `NOT_RUN`. Self-check results never substitute for user acceptance.
- **Codex Session**: Plans requirements, assigns stable unique IDs, defines observable `acceptanceCriteria` and dependency graphs (`dependsOn`), dispatches tasks, and performs **completeness-only checks** on the delivery checklist. Codex does not perform mandatory full-source reviews or act as a blocking UI interaction gate by default.
- **Codex-only releases**: GitHub/Gitee publication, new version releases, and their version metadata, release notes, packaging, signing, notarization, tags, artifact uploads, verification, and fixes use Codex models only. Split mixed development/release requests; do not dispatch release work to Antigravity.
- **User**: Performs final manual acceptance by testing the running application according to the manual test steps provided in the delivery report, and records decisions via `acceptance`.

The core local architecture consists of six modules plus a pure delivery workflow helper:

| Module | Responsibility |
| --- | --- |
| `router` | Normalizes work orders, scoped paths, `acceptanceCriteria`, `dependsOn`, and task settings. |
| `scheduler` | Enforces task state transitions (`AWAITING_USER_ACCEPTANCE`, `ACCEPTED`, `BLOCKED`, `CHANGES_REQUESTED`) and retry limits. |
| `worker-manager` | Runs the Worker CLI with argument arrays, maintains session continuity, and parses FULL / DELTA reports. |
| `context-manager` | Creates isolated worktrees, checks scope boundaries, and prepares targeted incremental feedback. |
| `task-store` | Persists schema 5-compatible task records, delivery/acceptance history, and task locks. |
| `watchdog` | Manages process timeouts and exit-related safeguards. |
| `task-store/delivery-workflow.mjs` | Pure helper module for report validation, checklist merging, no-progress detection, user feedback, and report formatting. |

There are no runtime package dependencies. The repository does **not** bundle external CLIs, accounts, credentials, or a graphical browser driver.

## Requirements

- Node.js 22 or later and Git.
- A Git repository with an existing commit; the isolated worktree is created from a committed baseline.
- A compatible, authenticated Antigravity CLI (`agy`) with structured output capabilities. Authentication, permissions, availability, and CLI compatibility are your responsibility.
- A Codex host session for planning, dispatching, and checklist completeness checks.
- macOS or a suitable POSIX environment. Linux has not been verified for this snapshot; native Windows is not supported.

Obtain external CLIs through official channels and authenticate Antigravity interactively before headless execution. Required Worker flags include `-p`, `--output-format json`, `--mode accept-edits`, and `--conversation`. The default `AUTO_APPROVE` permission policy additionally requires `--dangerously-skip-permissions`, `--sandbox`, and `--settings` support; missing capabilities block execution rather than silently dropping isolation. External accounts, model charges, and vendor licenses are separate from this project's MIT license.

The CLI can be inspected offline without invoking a model:

```sh
node cli.mjs help
node cli.mjs doctor --repo /absolute/path/to/project
```

## Installation

Run directly from a local checkout, or use the offline installer:

```sh
git clone https://github.com/SuAries/SuperAgent.git
cd SuperAgent
node cli.mjs help
node scripts/install.mjs
```

The default installation destination is `~/.codex/super-agent`. Choose another location if needed:

```sh
node scripts/install.mjs --dest /absolute/path/to/super-agent
```

An existing destination is not overwritten by default. To update an existing installation, stop running tasks and use `--force`:

```sh
node scripts/install.mjs --dest /absolute/path/to/super-agent --force
```

`npm run install:local` is an alias for the installer. The installer never modifies or overwrites your `AGENTS.md` automatically.

### Global and project instruction templates

- [Global instructions (ready-to-install)](templates/AGENTS.global.zh-CN.md): Concise, deploy-ready rules for protocol 4.0 / policy v1.0.
- [Bilingual templates](templates/): [English preset](templates/AGENTS.en.md) and [Chinese preset](templates/AGENTS.zh-CN.md) for manual integration into existing AGENTS files.

## Typical workflow

### 1. Create a work order

Prepare a JSON work order with observable criteria and optional dependencies based on [examples/workorder.example.json](examples/workorder.example.json):

```sh
node ~/.codex/super-agent/cli.mjs plan --file /absolute/path/to/workorder.json
```

Or register simple tasks from the command line:

```sh
node ~/.codex/super-agent/cli.mjs plan \
  --repo /absolute/path/to/project \
  --goal "Add a searchable list" \
  --scope "src/**" \
  --scope "docs/**"
```

### Release routing and Worker permissions

Set `taskKind: "RELEASE"` in release work orders (or `plan --task-kind RELEASE`). `run` and `auto` return `CODEX_ONLY` before Worker dispatch; the current Codex session handles the approved release. The CLI does not automatically launch Codex or publish. Goal/requirement wording is an additional routing safeguard, not a replacement for explicit classification.

Routine tasks default to `agyPermissionPolicy: "AUTO_APPROVE"`. Within the approved isolated worktree, Worker tool requests are automatically approved for that CLI session, including writes and commands. This does not expand task scope, authorize releases, expose credentials, or change global agy/system/Codex approval settings. Platform and administrator restrictions and explicit denials still apply. To retain normal approval prompts, set `agyPermissionPolicy: "STANDARD"` or use `plan --agy-permission-policy STANDARD`. Read the [full bilingual policy](docs/release-and-permissions.md) before dispatch.

### 2. Dispatch the Worker and auto-complete checklist

```sh
node ~/.codex/super-agent/cli.mjs auto --id YOUR_TASK_ID
```

- In turn 1, the Worker returns a `FULL` report covering every planned requirement ID.
- In subsequent turns, the Worker returns a `DELTA` report covering only changed items with `oldStatus`.
- Each delivery item provides `requirementId`, `status`, `implementation`, `changedFiles`, `selfChecks`, `manualTestSteps`, `expectedResult`, `remainingWork`, `remainingIssues`, `satisfiedCriteria`, and `blocker`.
- `auto` automatically continues the Worker session to resolve missing fields or unfulfilled items.
- **Partial blockers**: When one requirement is `BLOCKED`, independent requirements continue.
- **No-progress limit**: Two consecutive turns without substantive progress on the same item (`maxNoProgressRounds=2`, configured in WorkOrder) marks that item `BLOCKED` without infinite retries. Legacy `maxRepairRounds` is supported only for legacy modes; the default protocol is not a blanket two-round total cap.

### 3. Review delivery and export acceptance report

When all runnable items reach `READY_FOR_ACCEPTANCE`, the task enters `AWAITING_USER_ACCEPTANCE`. Inspect status or generate the report:

```sh
node ~/.codex/super-agent/cli.mjs status --id YOUR_TASK_ID
node ~/.codex/super-agent/cli.mjs inspect --id YOUR_TASK_ID --delivery
node ~/.codex/super-agent/cli.mjs report --id YOUR_TASK_ID --format markdown --file delivery-report.md
```

The report itemizes seven mutually-exclusive status counts whose sum equals $N$, along with manual test steps and blocker details. See [delivery-report.example.md](examples/delivery-report.example.md).

### 4. User manual testing and acceptance

The user tests the application using the documented manual test steps, then records decisions with `acceptance`:

```sh
node ~/.codex/super-agent/cli.mjs acceptance \
  --id YOUR_TASK_ID \
  --file /absolute/path/to/user-feedback.json
```

- When all requirements are `ACCEPTED`, the task reaches `ACCEPTED`.
- If an item is `REJECTED`, specific user feedback is dispatched back to the original Worker session for targeted repair.
- Unblocking an item after resolving external prerequisites uses `unblock`:
  ```sh
  node ~/.codex/super-agent/cli.mjs unblock --id YOUR_TASK_ID --requirement-id REQ-002 --reason "Credentials provided"
  ```

## Commands synopsis

Run `node cli.mjs help` for complete details:

| Command | Purpose |
| --- | --- |
| `doctor [--repo DIR] [--agy FILE] [--probe-write]` | Diagnose local prerequisites and paths. |
| `plan --file FILE` | Register a structured work order; supports `--task-kind DEVELOPMENT\|RELEASE` and `--agy-permission-policy AUTO_APPROVE\|STANDARD` for command-line work orders. |
| `auto --id ID [--agy FILE] [--worker-timeout-ms N]` | Dispatch routine coding and complete delivery checklist; release tasks return `CODEX_ONLY`. |
| `run --id ID [--agy FILE] [--timeout-ms N]` | Execute one routine Worker step; release tasks return `CODEX_ONLY`. |
| `inspect --id ID --delivery` | Show the delivery and handoff data. |
| `report --id ID [--format markdown\|json] [--file FILE]` | Export delivery and acceptance report. |
| `acceptance --id ID --file FILE` | Record user manual acceptance decisions (`ACCEPTED` / `REJECTED`). |
| `unblock --id ID --requirement-id REQ-ID --reason TEXT` | Reset a blocked requirement for resumption. |
| `status --id ID`, `list` | Inspect task state or list tasks. |
| `recover --id ID --reason TEXT` | Recover an eligible orphaned lock after confirming process exit. |

## Seven canonical statuses

Requirements are tracked across seven mutually-exclusive statuses:
1. `TODO`: Planned, not yet implemented.
2. `IN_PROGRESS`: Currently being coded/self-checked by Worker.
3. `PARTIAL`: Partially implemented; pending completion.
4. `READY_FOR_ACCEPTANCE`: Worker self-reports ready with full handoff details.
5. `BLOCKED`: Blocked by external prerequisites or no-progress limit.
6. `ACCEPTED`: **User only**: Explicitly tested and approved by user.
7. `REJECTED`: **User only**: Tested and rejected by user with defect feedback.

The Worker may set only the first five statuses. Only human user feedback submitted through `acceptance` can record `ACCEPTED` or `REJECTED`.

## Legacy compatibility

- **Schema 4 / Protocol 3.3 Tasks**: Older tasks and explicit `CODEX_FUNCTIONAL_CHECK` / `CODEX_STARTUP_CHECK` configurations remain supported. Historical `PASS` or `OPENED` observations are never converted into user `ACCEPTED`. See [legacy functional protocol](docs/en/functional-protocol.md) and [startup check specification](docs/启动打开验证规范.md).
- **Optional Full-Source Review**: The optional code review module (`inspect --code-review`, `review-agent`, `review --file`) remains available for explicit on-demand requests; see [code review specification](docs/Codex智能代码审查规范.md).

## Community and license

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), and [RELEASING.md](docs/RELEASING.md). Licensed under the [MIT License](LICENSE).

`package.json` retains `private: true` to prevent accidental npm publication; source sharing and forks under the MIT License are welcome.

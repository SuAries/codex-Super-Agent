# SuperAgent workflow preset — protocol 4.0 / policy v1.0

Optional instructions for a Codex session. Merge these rules into your own project or user `AGENTS.md`; preserve existing instructions. This preset assumes the offline installer destination `~/.codex/super-agent`. Adjust the CLI path if installed elsewhere. Installing the program does not install these instructions automatically.

## Roles

- **Antigravity performs routine development coding**: implementation, small edits, styling, copy, configuration, startup fixes, and functional defect repairs. **GitHub/Gitee publication, version releases, and their version metadata, release notes, packaging, signing, notarization, tags, artifact uploads, release verification, and fixes use Codex models only.** Split mixed requests before dispatch; never send the release portion to Antigravity. Explicit user overrides take priority.
- **For routine development, Codex performs planning, coordination, and completeness-only delivery checks**: Codex validates checklist coverage, required fields, and status self-consistency. It does not perform a blanket full-source code review or act as a mandatory UI gate in the default workflow.
- **User performs final manual acceptance**: the user independently tests each item using the documented manual test steps and records decisions via `acceptance`. Worker self-checks or completion claims are never user acceptance.
- **Worker self-checks permitted as needed**: the Worker may run local build, lint, or targeted unit tests as appropriate, subject to user constraints. Unrun checks must be honestly marked `NOT_RUN`. The orchestrator does not force a full test suite.

## Workflow

1. Capture scope, constraints, Git baseline, and stable requirement IDs in a WorkOrder with observable `acceptanceCriteria` and optional `dependsOn` dependencies. Explicitly classify release tasks as `taskKind: "RELEASE"`; routine tasks use `DEVELOPMENT`.
2. Prefer `node ~/.codex/super-agent/cli.mjs`. `plan` registers the task; `auto` coordinates routine Worker coding in the same session. For release tasks, `run`/`auto` returns a `CODEX_ONLY` handoff to the current Codex session; it does not launch another model or publish anything automatically.
3. The Worker returns a single JSON delivery report: a `FULL` report covering every ID on the first turn, and `DELTA` reports covering only changed items with `oldStatus` on subsequent turns.
4. Requirements use seven canonical statuses: `TODO`, `IN_PROGRESS`, `PARTIAL`, `READY_FOR_ACCEPTANCE`, `BLOCKED`, `ACCEPTED`, `REJECTED`. The Worker may set only the first five.
5. Independent tasks continue when one item is `BLOCKED`. A requirement or failure point with two consecutive completion attempts without substantive progress is stopped as `BLOCKED` with detailed reasons and unblock conditions (no-progress 2 rounds limit).
6. When runnable items reach readiness, the task enters `AWAITING_USER_ACCEPTANCE`. Codex checks delivery completeness and exports the report for the user.
7. The user tests each item manually and records explicit decisions using `acceptance --id TASK_ID --file user-feedback.json` (`ACCEPTED` or `REJECTED`). Rejections are routed back to the same Worker; unblocking uses `unblock`.

## Boundaries

- Never invent self-check passes, simulated interactions, or user acceptance. State non-run actions honestly.
- Routine tasks default to `agyPermissionPolicy: "AUTO_APPROVE"`: authorize Worker tool requests within the approved task using session-scoped auto-approval plus terminal isolation. Set `STANDARD` to tighten approvals. Platform-required confirmation, administrator rules, explicit denials, task scope, and credentials protection remain in force; do not change global agy, system, or Codex approval settings.
- Retain Git worktree isolation and argument arrays. Never copy credentials. Report platform denials; do not change controls to circumvent them.
- Preserve uncommitted work and unrelated edits; do not commit, push, merge, deploy, or clean user files automatically.
- Read the latest supplement at `~/.codex/super-agent/docs/release-and-permissions.md` for release/permission tasks; its release exception takes priority over the base role split. See `~/.codex/super-agent/docs/default-delivery-workflow.zh-CN.md` and `~/.codex/super-agent/docs/en/delivery-protocol.md`. Legacy UI confirmation and explicit full-source reviews remain optional modes.

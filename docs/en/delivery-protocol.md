# Delivery and Manual Acceptance Protocol

SuperAgent 0.7.0 uses collaboration protocol 4.0, implementing the Default Delivery and Manual Acceptance Policy v1.0. This document describes the default delivery workflow, data contracts, and CLI commands. The latest [release and permission supplement](../release-and-permissions.md) takes priority over the base role split for publication tasks. See [default-delivery-workflow.zh-CN.md](../default-delivery-workflow.zh-CN.md) for the canonical Chinese specification and the [examples/](../../examples/) directory for reference data shapes.

## Core Principles and Roles

The default collaboration protocol defines clear, non-overlapping responsibilities:

1. **Codex (Planning, Coordination, and Completeness Checks)**:
   - Breaks down user goals into stable, unique requirement IDs (e.g. `REQ-001`).
   - Defines observable `acceptanceCriteria` and dependency graphs (`dependsOn`).
   - Dispatches routine development tasks to the Antigravity Worker.
   - Performs GitHub/Gitee publication, version releases, and their version metadata, release notes, packaging, signing, notarization, tags, artifact uploads, release verification, and fixes with Codex models only. Split mixed requests; never dispatch the release portion to Antigravity.
   - Performs **completeness-only checks** on the Worker's delivery checklist (all IDs accounted for, mandatory fields populated, status consistency).
   - Exports the delivery report and manual test steps for the user.
   - **Does not** perform mandatory full-source code review or act as a blocking UI interaction gate by default.
2. **Antigravity Worker (Implementation and As-Needed Self-Checks)**:
   - Carries out routine development implementation, styling, copy, configuration, startup fixes, and bug repairs; release work belongs to Codex.
   - Uses session-scoped `AUTO_APPROVE` permissions with terminal isolation by default; `STANDARD` tightens approvals. This does not override platform/admin restrictions, explicit denials, task scope, credentials protection, or Codex-only release ownership.
   - May run local builds, linters, or targeted unit tests as self-checks when helpful and permitted by user constraints; unexecuted checks must be honestly marked `NOT_RUN`.
   - Returns a structured delivery envelope with implementation summaries, modified files, self-check facts, and reproducible manual test steps.
   - **Cannot** declare an item accepted by the user; self-checks and completion claims are not user acceptance.
3. **User (Final Manual Acceptance)**:
   - Executes the manual test steps provided in the delivery report against the running application or artifacts.
   - Records business decisions (`ACCEPTED` or `REJECTED`) via explicit user feedback.

---

## Three Separate Facts

- **Worker Delivery Claims & Self-Checks**: The Worker's declaration of what was implemented and any local tests run. `READY_FOR_ACCEPTANCE` means the Worker claims ready for user inspection; it does not prove correctness or constitute acceptance.
- **Codex Delivery Completeness Check**: A structural check verifying that the delivery report is well-formed, all work-order requirement IDs are covered, required fields exist, and no unaddressed blockers or missing fields remain.
- **User Acceptance**: The user's explicit, manual decision. No automated test, Worker self-check, or Codex inspection can bypass this human boundary.

---

## Seven Canonical Requirement Statuses

Each requirement row is tracked using one of seven mutually-exclusive statuses:

| Status | Meaning | Permitted Role | Next Action |
|---|---|---|---|
| `TODO` | Registered and planned; implementation not started | Codex / Worker | Dispatch or begin coding |
| `IN_PROGRESS` | Implementation and self-checks in progress | Worker | Complete coding and self-checks |
| `PARTIAL` | Partially implemented; does not meet all criteria | Worker | Continue implementing missing criteria |
| `READY_FOR_ACCEPTANCE` | Implementation complete with all fields; waiting for user | Worker (summarized by Codex) | User manual acceptance |
| `BLOCKED` | Blocked by external dependencies, permissions, or no-progress limit | Worker (recorded by Codex) | Resume after unblocking |
| `ACCEPTED` | User has explicitly tested and accepted the item | **User only** (via `acceptance`) | Item closed |
| `REJECTED` | User tested and rejected the item with specific feedback | **User only** (via `acceptance`) | Worker fixes defect |

> [!IMPORTANT]
> The Worker may set only the first five statuses (`TODO`, `IN_PROGRESS`, `PARTIAL`, `READY_FOR_ACCEPTANCE`, `BLOCKED`). Only explicit user feedback submitted via `acceptance` can set `ACCEPTED` or `REJECTED`.

---

## WorkOrder Schema

A WorkOrder registers tasks with stable IDs, constraints, and observable criteria:

```json
{
  "repo": "/absolute/path/to/project",
  "goal": "Implement user profile settings",
  "taskKind": "DEVELOPMENT",
  "agyPermissionPolicy": "AUTO_APPROVE",
  "scope": ["src/**", "public/**"],
  "constraints": [
    "Preserve existing auth token format",
    "Worker self-checks permitted as needed"
  ],
  "acceptance": [
    {
      "requirementId": "REQ-001",
      "requirement": "User can update display name",
      "acceptanceCriteria": [
        "Typing a new name and clicking Save persists the name",
        "Page reload displays the updated name"
      ],
      "dependsOn": []
    },
    {
      "requirementId": "REQ-002",
      "requirement": "Avatar upload with image preview",
      "acceptanceCriteria": [
        "Selecting a PNG or JPG shows an immediate preview",
        "Clicking Save uploads the image and updates header avatar"
      ],
      "dependsOn": ["REQ-001"]
    }
  ],
  "maxNoProgressRounds": 2,
  "maxConsecutiveFailures": 2,
  "defaultRunAutomatedTests": true
}
```

- `taskKind`: `DEVELOPMENT` by default; explicitly use `RELEASE` for publication/version tasks. Goal/requirement wording provides a fallback safeguard for old or mislabeled records; it does not replace explicit classification. Release `run`/`auto` returns `CODEX_ONLY` to the current Codex session without starting agy or automatically executing a release.
- `agyPermissionPolicy`: `AUTO_APPROVE` by default (session-scoped tool auto-approval plus terminal isolation), or `STANDARD` for normal approval behavior. Requires supported CLI isolation/permission flags; see the [supplement](../release-and-permissions.md).
- `requirementId`: Stable identifier, maintained across repair turns.
- `acceptanceCriteria`: Array of observable expectations (falls back to `requirement` if omitted).
- `dependsOn`: Predecessor requirement IDs. Cyclic or unknown dependencies are rejected.
- `maxNoProgressRounds`: Maximum consecutive completion attempts without substantive progress on a single item (defaults to 2) before marking it `BLOCKED`. Legacy `maxRepairRounds` is retained only for backwards compatibility; the new default mode does not impose a total two-round cap across the entire task.
- `defaultRunAutomatedTests`: Boolean flag allowing Worker as-needed local tests.

---

## Worker Delivery Report: FULL and DELTA

The Worker outputs a single valid JSON envelope in its turn:

```json
{
  "reportKind": "FULL",
  "baseRevision": 0,
  "summary": "Implemented display name update and avatar preview.",
  "launch": {
    "command": "npm run dev",
    "target": "http://localhost:5173",
    "kind": "web"
  },
  "delivery": [ ... ]
}
```

### Turn 1: FULL Report
The initial report must have `reportKind: "FULL"` and `baseRevision: 0`, containing exactly one row per planned requirement ID.

### Subsequent Turns: DELTA Report
Subsequent repair turns return `reportKind: "DELTA"` and `baseRevision: <current-revision>`. A DELTA report includes **only changed requirement items**, each specifying `oldStatus`. Unchanged items carry forward automatically.

### Mandatory Delivery Row Fields

Each item in `delivery` contains:

- `requirementId`: Stable ID matching WorkOrder.
- `status`: One of `TODO`, `IN_PROGRESS`, `PARTIAL`, `READY_FOR_ACCEPTANCE`, `BLOCKED`.
- `implementation`: Concise summary of what was implemented.
- `changedFiles` or `noChangeReason`: Array of modified relative paths.
- `selfChecks`: Array of `{ "action": string, "status": "PASSED" | "FAILED" | "NOT_RUN", "result": string }`.
- `manualTestSteps`: Array of `{ "action": string, "expected": string }`.
- `expectedResult`: Observable end-to-end outcome.
- `remainingWork`: Array of pending tasks (must be empty for `READY_FOR_ACCEPTANCE`).
- `remainingIssues`: Array of known non-blocking issues or caveats.
- `satisfiedCriteria`: Array of zero-based indexes of satisfied `acceptanceCriteria`.
- `blocker`: `null` if unblocked, or an object:
  ```json
  {
    "reason": "Missing external API credentials",
    "impact": ["REQ-002"],
    "attempted": [{ "action": "Checked local env", "result": "API key absent" }],
    "owner": "USER",
    "requiredAssistance": "Provide sandbox API key in local environment",
    "resumeWhen": "API key is exported"
  }
  ```

---

## Partial Blockers and No-Progress 2 Rounds Policy

1. **Partial Blockers Do Not Stall the Entire Task**: When a requirement is `BLOCKED`, any independent requirements without dependency on the blocked item continue in progress.
2. **No-Progress 2 Rounds Stopping Policy**: If the Worker attempts to complete or fix the same requirement or failure point across two consecutive turns without substantive progress (measured by status transitions, criteria satisfied, or remaining work completed, not altered wording or token count), the orchestrator stops retrying that item, marks it `BLOCKED`, and reports the blocker details. Other runnable items continue.
3. **Targeted Resumption**: When resuming a Worker session, the orchestrator passes only the changed, incomplete, or rejected items and their necessary context, rather than replaying the full history.

---

## Task-Level States

- `PENDING` / `PLANNING`: Task registered.
- `RUNNING`: Worker coding or self-checking.
- `AWAITING_USER_ACCEPTANCE`: All runnable items are `READY_FOR_ACCEPTANCE` (and any blocked items are clearly reported). Ready for manual user testing.
- `ACCEPTED`: All requirements have received explicit user acceptance (`ACCEPTED`).
- `BLOCKED`: No runnable or ready items remain, and unresolved blockers exist.
- `CHANGES_REQUESTED`: User rejected an item or delivery completeness check failed; items queued for repair.

---

## CLI Commands

### 1. Register a Task (`plan`)
```bash
node ~/.codex/super-agent/cli.mjs plan --file /path/to/workorder.json
```

### 2. Dispatch Coding and Checklist Completion (`auto`)
```bash
node ~/.codex/super-agent/cli.mjs auto --id <task-id>
```
`auto` invokes the Worker, validates the delivery envelope, and continues original Worker sessions to complete missing data or unfulfilled items. Once all non-blocked items reach `READY_FOR_ACCEPTANCE`, it transitions the task to `AWAITING_USER_ACCEPTANCE` and stops.

### 3. Generate Delivery and Acceptance Report (`report`)
```bash
node ~/.codex/super-agent/cli.mjs report --id <task-id> --format markdown --file delivery-report.md
```
Exports a summary report including seven mutually-exclusive status counts summing to $N$, per-requirement details, self-check facts, and manual test steps.

### 4. Record User Manual Acceptance (`acceptance`)
```bash
node ~/.codex/super-agent/cli.mjs acceptance --id <task-id> --file /path/to/user-feedback.json
```
User feedback file structure:
```json
{
  "taskId": "00000000-0000-4000-8000-000000000001",
  "checklistRevision": 1,
  "confirmedBy": "USER",
  "userFeedback": "Verified display name update; works as expected.",
  "decisions": [
    {
      "requirementId": "REQ-001",
      "decision": "ACCEPTED",
      "comment": "Persists correctly across reloads."
    },
    {
      "requirementId": "REQ-002",
      "decision": "REJECTED",
      "comment": "Preview works, but clicking save shows a 404 error.",
      "issueId": "avatar-upload-404"
    }
  ]
}
```
- Stale `checklistRevision` numbers are rejected.
- `ACCEPTED` transitions ready items to accepted.
- `REJECTED` transitions items to `REJECTED` and dispatches precise feedback back to the same Worker.

### 5. Unblock a Requirement (`unblock`)
```bash
node ~/.codex/super-agent/cli.mjs unblock --id <task-id> --requirement-id REQ-002 --reason "Sandbox credentials provided"
```
Resets the requirement from `BLOCKED` to `TODO` or `IN_PROGRESS` for subsequent `auto` execution.

---

## Legacy Compatibility

- **Schema 4 / Protocol 3.3 Tasks**: Remain fully readable and operable. Existing `CODEX_FUNCTIONAL_CHECK` and `CODEX_STARTUP_CHECK` records retain their original historical semantics.
- **No Silent Conversions**: Legacy `PASS` or `OPENED` observations are never automatically converted into user `ACCEPTED` status.
- **Optional Full-Source Review**: The optional Codex reviewer (`review-agent`, `review --file`) remains available for explicit on-demand source code audits; it is never triggered by default.

# Functional delivery protocol (Legacy / Explicit Optional)

> [!NOTE]
> In SuperAgent 0.7.0 (protocol 4.0), the global default workflow is the [Delivery and Manual Acceptance Protocol](delivery-protocol.md) (implementing Default Delivery Workflow Policy v1.0).
> This document describes the legacy / explicit optional `CODEX_FUNCTIONAL_CHECK` mode (protocol 3.3), retained for existing tasks and for workflows where an explicit Codex UI check is requested. Under the default protocol 4.0, Codex performs completeness-only checks on the delivery checklist without a mandatory UI confirmation gate, and final business acceptance is conducted by the user. Historical `PASS` observations are never automatically converted into user `ACCEPTED`.

## Three separate facts

1. **Worker delivery** is Antigravity's account of what it implemented. `IMPLEMENTED` is a self-report, not evidence that the feature is correct.
2. **Current Codex functional confirmation** records a review of the delivery list, a read of necessary relevant feature code, and actual brief operations on the target. A pass is limited to what was observed; it is not a comprehensive code review or proof of overall correctness.
3. **User acceptance** is the user's later manual business acceptance. Neither a Worker report nor `READY_FOR_USER_TEST` means the user has accepted the result.

The protocol does not run automated unit, integration, or E2E tests, lint, typecheck, or CI, and does not perform a comprehensive source review unless requested. The current Codex session must actually observe the target: a running process, an HTTP response, or a Worker claim alone does not establish a functional pass.

## WorkOrder

`plan` registers a task without starting coding. A WorkOrder supplies the repository, goal, permitted `scope`, constraints and `acceptance` requirements, with a stable, unique `requirementId` for each requirement. Tasks explicitly specifying `reviewMode: "CODEX_FUNCTIONAL_CHECK"` use this mode. See [workorder.example.json](../../examples/workorder.example.json).

```bash
node cli.mjs plan --file /path/to/workorder.json
node cli.mjs auto --id <task-id>
```

Use the ID returned by `plan`. The independent Git worktree starts from a committed baseline; it does not copy uncommitted changes from the original worktree.

## Worker delivery

The Worker returns a single valid JSON object without surrounding text, containing `summary`, `launch` information, and a `delivery` array. Every acceptance ID must appear exactly once, with no unknown IDs. Each entry has `requirementId`, `status`, `implementation`, `entry`, `expectedResult`, and `changedFiles`.

- `IMPLEMENTED`: the Worker reports implementation complete.
- `INCOMPLETE`: not complete; include `reason`.
- `BLOCKED`: externally blocked; include `reason` and `unblockConditions`.

See [worker-delivery.example.json](../../examples/worker-delivery.example.json). Inspect the real report and changed-file list with:

```bash
node cli.mjs inspect --id <task-id> --delivery
```

A missing, malformed, incomplete, duplicate, or mismatched delivery list is fed back to the original Worker session by `auto`, within the shared repair budget. A reported `BLOCKED` item stops the task and identifies the reason and conditions for proceeding. When all requirements are reported `IMPLEMENTED`, the task reaches `AWAITING_FUNCTIONAL_CHECK`.

## Current Codex confirmation

When `CODEX_FUNCTIONAL_CHECK` is configured, the current Codex session checks the delivery list and changed files, reads only necessary feature code, then opens the App or web page and briefly exercises each requirement. For CLI or configuration work, it records the actual command output or configuration facts rather than inventing browser interaction. Record startup and each observed result honestly; lack of access or observation is not a pass.

`confirm` accepts a complete structured JSON report through `--file`:

```bash
node cli.mjs confirm --id <task-id> --file /path/to/functional-check.json
```

Use [functional-check.example.json](../../examples/functional-check.example.json) as a format reference, not as evidence. Replace example IDs, paths, attempt numbers, times and observations with the real task and results. The report binds `taskId`, `workerAttempt`, and `worktreePath` to the current task and attempt; it includes `outcome`, `verificationScope: "FUNCTIONAL_CHECK"`, `checkedBy: "CODEX_CURRENT_SESSION"`, `observedAt`, `summary`, and an `items` array. Each requirement must occur exactly once with `result`, `codeEvidence`, `action`, `expected`, and `observed`. A `FAIL` requires `error` or `reason`; `NOT_VERIFIED` and `BLOCKED` require `reason`.

For `PASSED`, all items must be `PASS`, and `startup` must describe a real, nonempty target with `kind` of `web`, `app`, `cli`, or `config`, `opened: true`, and no startup errors. A web target must be a valid HTTP, HTTPS, or file URL. These fields must represent actual observation, not merely satisfy validation.

## Outcomes and repair budget

| Report outcome | Task result |
| --- | --- |
| `PASSED` | `READY_FOR_USER_TEST`; keep the target and needed services available for the user's final manual test. |
| `FUNCTIONAL_FAILED` | `CHANGES_REQUESTED` if budget remains; report the failed requirement, action, expected and observed behavior to the original Worker. Otherwise `BLOCKED`. |
| `NOT_VERIFIED` or `BLOCKED` | `BLOCKED`; explain the missing access, target, observation, or other condition. |

`FUNCTIONAL_FAILED` requires an observed failed item or startup error. After a repair, the current Codex session performs and records confirmation again against the current attempt. The initial coding attempt is not a repair. Delivery-list completion, startup repairs, and functional repairs share the configured repair rounds limit; a stopped or exhausted task must not be represented as passing.

`auto` does not drive a browser or launch a background planning model to complete the check. It hands off at `AWAITING_FUNCTIONAL_CHECK`; the current Codex host needs the appropriate observation tools.

## Older tasks and compatibility

Schema 4 records remain readable. Existing `CODEX_STARTUP_CHECK` tasks and `verify` preserve their `STARTUP_ONLY` meaning. A historical startup-only observation or protocol 3.3 functional pass is not converted into a protocol 4.0 user `ACCEPTED` decision.

# Working on SuperAgent

This repository contains the local orchestrator, public documentation, and optional instruction templates. Follow the user's current task and explicit model/delegation choices first. The application workflow presets live in `templates/`; they are not a requirement that every community contributor use an external coding service.

## Read only what the task needs

- Start with `README.md` or `README.zh-CN.md` for setup and supported behavior.
- For default delivery and manual acceptance workflow (protocol 4.0 / policy v1.0), read `docs/default-delivery-workflow.zh-CN.md` or `docs/en/delivery-protocol.md`.
- For legacy functional checks or startup-only tasks, see `docs/en/functional-protocol.md`, `docs/逐项交付与功能确认规范.md`, or `docs/启动打开验证规范.md`.
- For module boundaries, read `docs/en/architecture.md`.
- For release routing, publication, or Worker permissions, read `docs/release-and-permissions.md` before dispatch. GitHub/Gitee publication and version-release work use Codex models only; routine development remains Antigravity-owned.
- For packaging or publication, also read `docs/RELEASING.md`.

## Keep implementation and claims aligned

- Preserve stable requirement IDs, original Worker conversation IDs, task locks, process-exit checks, and the no-progress two-round retry boundary.
- Keep Worker implementation claims, self-check facts, Codex completeness checks, and user manual acceptance strictly separate. A Worker report, self-check pass, or opened page is never user acceptance.
- Default workflow relies on Codex completeness-only checks of the delivery checklist and hands off manual testing steps to the user; do not expand into a repository-wide code audit or mandatory UI confirmation gate without an explicit request.
- Worker as-needed self-checks (build, lint, local tests) are permitted unless forbidden by user constraints; report unrun checks honestly as `NOT_RUN`. Do not claim unrun checks passed.
- Do not invoke live model CLIs merely to check documentation or packaging. `help` and an offline temporary install are sufficient for those startup checks; report their limits.
- Preserve existing dirty work, runtime state, and unrelated changes. Do not commit, push, merge, deploy, or publish unless asked.
- Use the session-scoped `AUTO_APPROVE` Worker policy only for authorized development in an isolated worktree. Platform/admin restrictions, explicit denials, task scope, credentials protection, and Codex-only release ownership still apply; never modify global CLI or system approval settings.

## Protect the public source bundle

- Never commit `.state/`, `.workspaces/`, CLI binaries, account settings, credentials, transcripts, raw model logs, or private project code.
- Use generic paths and synthetic IDs in examples. Do not copy a real successful observation into a reusable confirmation template.
- Keep installation offline and opt-in. Never overwrite a user's `AGENTS.md` or CLI account configuration automatically.
- Keep examples and both README languages synchronized with the actual CLI. Do not invent platform support, test results, token savings, or public release status.

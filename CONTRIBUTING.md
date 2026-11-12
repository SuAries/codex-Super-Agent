# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Thank you for helping improve SuperAgent. You can contribute bug reports, documentation, proposals, or code. The default Antigravity/Codex division is a workflow preset, not a condition of the MIT license or a requirement for community contributions. Human contributors and their chosen tools are welcome.

## Before starting

1. Search existing issues and pull requests for related work. For a substantial change, open an issue describing the problem and proposed approach before investing in an implementation.
2. Read the [README](README.md), the relevant protocol documentation ([Delivery protocol](docs/en/delivery-protocol.md) or [Canonical Chinese policy](docs/default-delivery-workflow.zh-CN.md)), and [SECURITY.md](SECURITY.md). Report security vulnerabilities privately as described there.
3. Work in your own branch or checkout. Preserve unrelated local changes and avoid including runtime task records, credentials, personal data, or local configuration in a patch.
4. Keep changes focused. Explain any compatibility or behavior changes, especially around task state, CLI contracts, worktree isolation, permissions, and recovery.

## Reporting a problem

Use the bug report template where available. Include a minimal reproduction, expected and observed results, relevant requirement IDs and commands, versions of the OS, Node, Git, and external CLIs, and what you actually verified. Redact tokens, account details, personal paths, and project data; do not post full logs containing sensitive information. For security issues follow [SECURITY.md](SECURITY.md), not a public issue.

## Proposing a change

Describe the user problem, the behavior you want, alternatives, and any compatibility or permission implications. The [roadmap](docs/ROADMAP.md) contains proposals, not promises or shipped capabilities. Please distinguish verified platform behavior from assumptions.

## Pull requests

Explain the change and its motivation, reference the relevant issue if one exists, and complete the pull request template:
- List the checks you actually performed and their limits, including any self-checks or UI behavior you observed, and what remains unverified.
- Never claim an automated test suite or CI passed unless you actually ran and observed it.
- Distinguish Worker self-checks from user manual acceptance.
- Documentation-only changes can be checked by verifying links and examples; code changes should include verification appropriate to their risk and scope.

Maintainers may request changes or discuss design alternatives. There is no guaranteed response time. By contributing, you agree that your contribution is provided under the repository's [MIT License](LICENSE).

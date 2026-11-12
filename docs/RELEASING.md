# Release preparation / 发布准备

**Codex models only.** GitHub/Gitee publication, new version releases, and their version metadata, release notes, packaging, signing, notarization, tags, artifact uploads, release verification, and fixes belong to the current Codex session. Split mixed development/release requests; never dispatch their release portion to Antigravity. Explicitly use `taskKind: "RELEASE"`; `run`/`auto` returns `CODEX_ONLY` without starting a model or publishing. See the [release and permission supplement](release-and-permissions.md).

This is a maintainer checklist, not evidence that a repository or release has been published. Publishing, pushing, tagging, or creating a release requires authorization for the intended destination and contents; act on existing explicit authorization without repeatedly asking. These instructions do not execute those actions.

1. Confirm the approved version (currently engine 0.7.0, protocol 4.0), release scope, destination and release notes. The intended GitHub URL is `https://github.com/SuAries/SuperAgent`; verify the actual destination before publishing. For Gitee, use only the destination the user provides or confirms; no Gitee URL is assumed.
2. Confirm [LICENSE](../LICENSE) contains the selected MIT terms and copyright, and verify the source-only package includes the README translations, templates (including `templates/AGENTS.global.zh-CN.md`), examples (FULL/DELTA reports, user feedback, markdown delivery report), documentation (`docs/default-delivery-workflow.zh-CN.md`, `docs/en/delivery-protocol.md`) and installer needed by users. Exclude credentials, private task state, personal data, local configuration and unrelated work.
3. Review changes and verify the documented commands and links against the intended artifact. Record the actual environment and the checks performed, including any missing runtime or platform verification. macOS manual runtime evidence does not establish Linux or native Windows support. Do not claim automated tests or CI without evidence.
4. Verify version metadata and changelog, prepare the intended source artifact and confirm that the exact destination and contents fall within the user’s existing authorization before creating a tag, pushing, or publishing a GitHub/Gitee release. Ask only for a missing required decision. Inspect the published artifact after an authorized release.
5. `package.json` intentionally retains `private: true`: this is GitHub-oriented source packaging, not an npm publication instruction. Do not run `npm publish` blindly or remove that protection without a separate decision.

## First GitHub upload (manual instructions only)

1. On GitHub, create the intended repository under the correct owner, choose **Public**, and leave initial README/license generation off because this folder already contains them. If the proposed name is unavailable, update the clone, repository, homepage, and issue URLs before uploading.
2. Work from this clean source folder, not an installed runtime directory. Inspect every file before staging. Once the exact destination and upload are approved, the following is one possible manual sequence:

```sh
git init -b main
git add .
git diff --cached --name-only
git commit -m "chore: prepare initial public source snapshot"
git remote add origin https://github.com/SuAries/SuperAgent.git
git push -u origin main
```

3. Confirm the public README language links, license, examples, and issue/PR templates render correctly. Enable Issues and, if wanted, Discussions in repository settings. Enable private vulnerability reporting if it will be maintained; do not claim it is enabled before doing so.
4. A source push does not create a version tag, GitHub Release, binary distribution, npm package, or proof of platform compatibility. Treat those as separate future actions.

No command above has been executed by this source-preparation task.

## 中文

**只使用 Codex 模型。** GitHub/Gitee 上传发布、新版本及为该次发布进行的版本号、更新说明、打包、签名、公证、标签、产物上传、发布验证和修复，均由当前 Codex 会话执行。混合需求先拆分，发布部分不交给 agy；显式使用 `taskKind: "RELEASE"`，`run`/`auto` 返回 `CODEX_ONLY`，不会自动启动模型或发布。详见[发布与权限补充规则](release-and-permissions.md)。

本清单是维护者的准备指引，并不代表仓库或版本已经发布。推送、打标签、创建仓库或发布版本须在用户授权的具体目标和内容范围内执行；已有明确授权时不重复询问。本文不会执行这些操作。

1. 确认批准的版本（当前为引擎 0.7.0、协议 4.0）、范围、目标位置和更新说明。计划中的 GitHub 地址为 `https://github.com/SuAries/SuperAgent`，发布前核实实际目标。Gitee 仅使用用户提供或确认的目标，不预设或虚构仓库地址。
2. 确认 [LICENSE](../LICENSE) 包含选定的 MIT 条款和版权信息；确认源码包包含用户需要的双语说明、模板（含 `templates/AGENTS.global.zh-CN.md`）、示例（FULL/DELTA 报文、用户反馈、Markdown 交付报告）、文档（`docs/default-delivery-workflow.zh-CN.md`、`docs/en/delivery-protocol.md`）和安装器。排除凭据、私有任务状态、个人数据、本地配置及无关内容。
3. 对照拟发布的内容检查改动、命令和链接；记录真实环境、已执行的检查和未验证事项。macOS 手工运行证据不能证明 Linux 或原生 Windows 受支持；没有证据时不要声称自动化测试或 CI 通过。
4. 核对版本元数据和更新记录，准备源码产物，并在打标签、推送或创建 GitHub/Gitee Release 前核对具体目标与内容已处于用户授权范围；只有缺少必要决定时再请求补充。获授权发布后检查实际产物。
5. `package.json` 保留 `private: true` 是有意的：此处面向 GitHub 源码分发，并非 npm 发布指令。不要盲目运行 `npm publish`，也不要在没有单独决定时移除此保护。

### 首次上传 GitHub（仅操作说明）

1. 在 GitHub 正确的账号下创建拟定仓库，选择 **Public**。本文件夹已有 README 和 LICENSE，不要让远程仓库再生成同名初始化文件；如果改用其他仓库名，先同步 clone、repository、homepage 与问题反馈链接。
2. 在这份干净的源码文件夹中操作，不要在实际安装后的运行时目录操作。检查待上传文件，确认具体目标和上传授权后，可按上面的 Git 命令初始化、暂存、检查文件名、提交并推送；这只是后续手工说明，本次整理没有执行。
3. 上传后检查中英文切换、MIT、示例及 issue/PR 模板；根据实际维护安排启用 Issues、Discussions 和私密漏洞报告，未启用前不要对外承诺已提供。
4. 推送源码不等于已创建标签、GitHub Release、二进制或 npm 包，也不等于所有平台均验证通过。这些应作为后续独立动作处理。

## Gitee publication / Gitee 发布

Use the user-authorized Gitee owner/repository and access method. Codex prepares the intended source/artifact and release notes, performs the authorized push/tag/release actions, and checks the actual published contents. Gitee permissions and release interfaces may differ from GitHub; use the available official interface without assuming identical commands. Do not copy account settings or embed tokens in the public source.

使用用户授权的 Gitee 账号、仓库与访问方式。Codex 准备源码或产物、更新说明，执行授权范围内的推送、标签及版本发布，再核对实际公开内容。Gitee 权限和发布接口可能与 GitHub 不同，按可用官方接口操作，不假设命令完全一致。不复制账号配置，不将令牌写入公开源码。

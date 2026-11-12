/** Model ownership is independent of checklist acceptance or tool approval. */
export function normalizeTaskKind(value = 'DEVELOPMENT') {
  if (typeof value !== 'string' || !['DEVELOPMENT', 'RELEASE'].includes(value.toUpperCase())) {
    throw new Error('taskKind 必须为 DEVELOPMENT 或 RELEASE');
  }
  return value.toUpperCase();
}

export function normalizeAgyPermissionPolicy(value = 'AUTO_APPROVE') {
  if (typeof value !== 'string' || !['AUTO_APPROVE', 'STANDARD'].includes(value.toUpperCase())) {
    throw new Error('agyPermissionPolicy 必须为 AUTO_APPROVE 或 STANDARD');
  }
  return value.toUpperCase();
}

// Explicit taskKind is authoritative for release ownership. Text matching is a
// conservative backstop for older plans, never a substitute for Codex planning.
// Inspect requested work only: default prohibitions in constraints are not goals.
const RELEASE_INTENT = [
  /(?:发布|上传|推送|同步|开源).{0,28}(?:github|gitee|git\s*hub|码云)/iu,
  /(?:github|gitee|码云).{0,28}(?:发布|上传|推送|开源|release|版本)/iu,
  /(?:发布|发行|推出|上线|更新|升级).{0,10}(?:新版本|版本\s*v?\d|正式版|发行版)/iu,
  /(?:发布|发行|推出|上线)\s*v?\d+\.\d+(?:\.\d+)?/iu,
  /(?:新版本|版本|正式版|发行版).{0,12}(?:发布|发行|上线|打包|签名|公证|上传)/u,
  /(?:发布|发行).{0,12}(?:准备|流程|配置|策略|规则|修复|问题|说明|产物|包)/u,
  /(?:创建|更新|推送|发布|上传|删除).{0,12}(?:release|tag|标签)/iu,
  /\b(?:publish|release|ship|upload|push)\b.{0,36}\b(?:github|gitee|version|release|artifact|build|tag|package)\b/iu,
  /\b(?:github|gitee)\b.{0,28}\b(?:publish|release|upload|push)\b/iu,
  /\b(?:prepare|create|update|fix|sign|notarize|package)\b.{0,28}\b(?:release|publishing|distribution)\b/iu,
  /\b(?:release|publishing|distribution)\b.{0,28}\b(?:prepare|create|update|fix|sign|notariz\w*|packag\w*|upload|notes|workflow|policy)\b/iu,
  /\b(?:release|publish|ship|tag)\s+v?\d+\.\d+(?:\.\d+)?\b/iu,
  /\bgit\s+(?:push|tag)\b/iu,
  /\b(?:gh|gitee)\s+release\b/iu
];

export function resolveExecutionPolicy(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('执行策略缺少有效 WorkOrder');
  const taskKind = normalizeTaskKind(plan.taskKind);
  const requestedWork = [plan.goal, ...(Array.isArray(plan.acceptance) ? plan.acceptance.map(item =>
    typeof item === 'string' ? item : item?.requirement) : [])].filter(value => typeof value === 'string');
  const inferredRelease = requestedWork.some(value => RELEASE_INTENT.some(pattern => pattern.test(value)));
  if (taskKind === 'RELEASE' || inferredRelease) {
    return {
      target: 'CODEX_ONLY',
      taskKind: 'RELEASE',
      reason: taskKind === 'RELEASE' ? '工作单明确指定发布任务，仅由 Codex 模型执行。' : '目标或需求包含发布相关工作，仅由 Codex 模型执行。'
    };
  }
  return { target: 'ANTIGRAVITY', taskKind, reason: '常规开发由 Antigravity 编码，Codex 负责规划和交付清单核对。' };
}

export function assertAntigravityTask(plan) {
  const policy = resolveExecutionPolicy(plan);
  if (policy.target === 'CODEX_ONLY') {
    throw Object.assign(new Error(policy.reason + ' 请交回当前 Codex 会话；混合任务先拆分开发与发布阶段。'), {
      code: 'ERR_CODEX_ONLY', executionPolicy: policy
    });
  }
  return policy;
}

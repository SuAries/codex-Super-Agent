import fs from 'node:fs';
import path from 'node:path';
import { validateDependencies } from '../task-store/delivery-workflow.mjs';
import { normalizeTaskKind, normalizeAgyPermissionPolicy } from './execution-policy.mjs';
export * from './execution-policy.mjs';

const ALLOWED_WORK_ORDER_KEYS = new Set([
  'goal',
  'repo',
  'scope',
  'constraints',
  'acceptance',
  'maxRepairRounds',
  'maxConsecutiveFailures',
  'maxNoProgressRounds',
  'defaultRunAutomatedTests',
  'reviewMode',
  'taskKind',
  'agyPermissionPolicy'
]);

/**
 * 校验并规范化 scope 规则：
 * 支持相对路径、简单 glob (如 src/**, components/*.vue)，禁止绝对路径、路径穿越和显式空范围
 */
export function normalizeScope(scopeInput) {
  if (scopeInput === undefined || scopeInput === null) {
    throw new Error('scope 不能为空；请明确指定允许修改的代码范围（如 "src/**"）');
  }

  let list = [];
  if (Array.isArray(scopeInput)) {
    list = scopeInput;
  } else if (typeof scopeInput === 'string') {
    list = [scopeInput.trim()];
  } else {
    throw new Error('scope 必须是字符串或非空字符串数组');
  }

  if (list.length === 0) {
    throw new Error('scope 不能是空数组或空字符串；禁止隐式扩大到全仓库');
  }

  const seen = new Set();
  const result = [];

  for (const rawItem of list) {
    if (typeof rawItem !== 'string' || !rawItem.trim()) {
      throw new Error('scope 列表项必须为非空字符串');
    }
    const item = rawItem.trim();
    if (item.includes('\\') || item.split('/').includes('..') || item.includes('\0')) {
      throw new Error(`scope 含不支持的分隔符或路径穿越：${item}`);
    }
    if (path.isAbsolute(item)) {
      throw new Error(`scope 不能是绝对路径：${item}；必须为相对路径或 glob`);
    }
    const normalized = path.normalize(item);
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error(`scope 禁止路径穿越：${item}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }

  return result;
}

/**
 * 校验 acceptance 列表：
 * 每条必须包含稳定的 requirementId 与 requirement 描述
 */
export function normalizeAcceptance(acceptanceInput, fallbackGoal) {
  if (acceptanceInput === undefined) {
    if (!fallbackGoal || typeof fallbackGoal !== 'string' || !fallbackGoal.trim()) {
      throw new Error('缺少 acceptance 且 goal 无效，无法生成验收条件');
    }
    return [{
      requirementId: 'REQ-1',
      requirement: fallbackGoal.trim(),
      codeEvidenceExpected: '相关修改必须有真实源码证据',
      acceptanceCriteria: [fallbackGoal.trim()],
      parentRequirementId: null,
      dependsOn: []
    }];
  }

  if (!Array.isArray(acceptanceInput) || acceptanceInput.length === 0) {
    throw new Error('acceptance 必须是非空数组');
  }

  const seenIds = new Set();
  const normalizedList = [];

  for (let index = 0; index < acceptanceInput.length; index++) {
    const item = acceptanceInput[index];

    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (!trimmed) {
        throw new Error(`acceptance[${index}] 字符串描述不能为空`);
      }
      const reqId = `REQ-${index + 1}`;
      if (seenIds.has(reqId)) {
        throw new Error(`acceptance ID 冲突: ${reqId}`);
      }
      seenIds.add(reqId);
      normalizedList.push({
        requirementId: reqId,
        requirement: trimmed,
        codeEvidenceExpected: '相关修改必须有真实源码证据',
        acceptanceCriteria: [trimmed],
        parentRequirementId: null,
        dependsOn: []
      });
      continue;
    }

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`acceptance[${index}] 必须为非空对象或字符串`);
    }

    const allowedKeys = ['requirementId', 'requirement', 'codeEvidenceExpected', 'acceptanceCriteria', 'parentRequirementId', 'dependsOn'];
    for (const key of Object.keys(item)) {
      if (!allowedKeys.includes(key)) throw new Error(`acceptance[${index}] 含未知字段：${key}`);
    }
    const rawReqId = item.requirementId;
    if (rawReqId !== undefined && typeof rawReqId !== 'string') throw new Error(`acceptance[${index}] requirementId 必须是字符串`);
    if (item.codeEvidenceExpected !== undefined && (typeof item.codeEvidenceExpected !== 'string' || !item.codeEvidenceExpected.trim())) throw new Error(`acceptance[${index}] codeEvidenceExpected 必须为非空字符串`);
    const reqId = rawReqId !== undefined ? rawReqId.trim() : `REQ-${index + 1}`;
    if (!reqId) {
      throw new Error(`acceptance[${index}] 的 requirementId 不能为空`);
    }

    if (seenIds.has(reqId)) {
      throw new Error(`acceptance 存在重复的 requirementId: ${reqId}`);
    }
    seenIds.add(reqId);

    if (typeof item.requirement !== 'string' || !item.requirement.trim()) {
      throw new Error(`acceptance[${index}] (${reqId}) 的 requirement 描述不能为空且必须为字符串`);
    }

    let criteria = [];
    if (item.acceptanceCriteria !== undefined) {
      if (Array.isArray(item.acceptanceCriteria)) {
        criteria = item.acceptanceCriteria.map(c => {
          if (typeof c !== 'string' || !c.trim()) throw new Error(`acceptance[${index}] 的 acceptanceCriteria 项必须为非空字符串`);
          return c.trim();
        });
      } else if (typeof item.acceptanceCriteria === 'string' && item.acceptanceCriteria.trim()) {
        criteria = [item.acceptanceCriteria.trim()];
      } else {
        throw new Error(`acceptance[${index}] 的 acceptanceCriteria 必须为非空字符串数组`);
      }
    }
    if (criteria.length === 0) {
      criteria = [item.requirement.trim()];
    }

    const parentRequirementId = item.parentRequirementId ? String(item.parentRequirementId).trim() : null;
    let dependsOn = [];
    if (item.dependsOn !== undefined) {
      if (!Array.isArray(item.dependsOn)) throw new Error(`acceptance[${index}] 的 dependsOn 必须为数组`);
      dependsOn = item.dependsOn.map(d => {
        if (typeof d !== 'string' || !d.trim()) throw new Error(`acceptance[${index}] 的 dependsOn 项必须为非空字符串`);
        return d.trim();
      });
    }

    normalizedList.push({
      requirementId: reqId,
      requirement: item.requirement.trim(),
      codeEvidenceExpected: item.codeEvidenceExpected ? String(item.codeEvidenceExpected).trim() : '相关修改必须有真实源码证据',
      acceptanceCriteria: criteria,
      parentRequirementId,
      dependsOn
    });
  }

  // 依赖合法性与循环检测
  validateDependencies(normalizedList);

  return normalizedList;
}

const DEFAULT_CONSTRAINTS = [
  '只修改任务相关代码，不擅自扩大范围',
  '不修改用户原始工作区，不提交、推送或部署代码',
  '默认不运行 lint、test、build、typecheck 或 CI',
  '仅在用户明确要求并授权时执行自动化测试'
];

const DELIVERY_DEFAULT_CONSTRAINTS = [
  '只修改任务相关代码，不擅自扩大范围',
  '不修改用户原始工作区，不提交、推送或部署代码',
  '允许 Worker 按需进行构建、Lint 与局部测试等自检；自检结果不替代用户手动验收',
  '业务功能由用户最终手动验收'
];

/**
 * 严格制定 Router WorkOrder
 */
export function planWork(rawInput) {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new Error('planWork 必须接收有效配置对象');
  }

  // 严格白名单校验输入字段，存在未知拼写直接报错
  for (const key of Object.keys(rawInput)) {
    if (!ALLOWED_WORK_ORDER_KEYS.has(key)) {
      throw new Error(`WorkOrder 包含未知或拼写错误的参数：${key}。禁止静默忽略`);
    }
  }

  const {
    goal,
    repo,
    scope,
    constraints = [],
    acceptance,
    maxRepairRounds = 2,
    maxConsecutiveFailures = 2,
    maxNoProgressRounds = 2,
    defaultRunAutomatedTests,
    reviewMode = 'CODEX_DELIVERY_CHECK',
    taskKind,
    agyPermissionPolicy
  } = rawInput;

  if (typeof goal !== 'string' || !goal.trim()) {
    throw new Error('goal 不能为空且必须为非空字符串');
  }

  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    throw new Error('repo 必须是有效仓库路径字符串');
  }

  if (!Number.isInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 5) {
    throw new Error('maxRepairRounds 必须是 0 到 5 之间的整数');
  }

  if (!Number.isInteger(maxConsecutiveFailures) || maxConsecutiveFailures < 1 || maxConsecutiveFailures > 5) {
    throw new Error('maxConsecutiveFailures 必须是 1 到 5 之间的整数');
  }

  if (!Number.isInteger(maxNoProgressRounds) || maxNoProgressRounds < 1 || maxNoProgressRounds > 5) {
    throw new Error('maxNoProgressRounds 必须是 1 到 5 之间的整数');
  }

  const isDeliveryMode = reviewMode === 'CODEX_DELIVERY_CHECK';
  const resolvedDefaultTests = defaultRunAutomatedTests !== undefined ? defaultRunAutomatedTests : (isDeliveryMode ? true : false);

  if (isDeliveryMode) {
    if (typeof resolvedDefaultTests !== 'boolean') {
      throw new Error('defaultRunAutomatedTests 必须为布尔值');
    }
  } else {
    if (resolvedDefaultTests !== false) {
      throw new Error('旧审查模式下 defaultRunAutomatedTests 必须为 false；系统严禁默认执行自动化测试');
    }
  }

  if (!['CODEX_DELIVERY_CHECK', 'CODEX_FUNCTIONAL_CHECK', 'CODEX_STARTUP_CHECK', 'CODEX_SEMANTIC_CODE_REVIEW'].includes(reviewMode)) {
    throw new Error(`不支持的审查模式：${reviewMode}`);
  }

  const normalizedScope = normalizeScope(scope);
  const normalizedAcceptance = normalizeAcceptance(acceptance, goal);

  // 严格校验 constraints 必须为字符串数组，禁止传入对象变 "[object Object]"
  let userConstraints = [];
  if (Array.isArray(constraints)) {
    for (let i = 0; i < constraints.length; i++) {
      const c = constraints[i];
      if (typeof c !== 'string' || !c.trim()) {
        throw new Error(`constraints[${i}] 必须为非空字符串，不可为对象或空值`);
      }
      userConstraints.push(c.trim());
    }
  } else if (typeof constraints === 'string' && constraints.trim()) {
    userConstraints.push(constraints.trim());
  } else {
    throw new Error('constraints 必须为字符串或字符串数组');
  }

  const baseConstraints = isDeliveryMode ? DELIVERY_DEFAULT_CONSTRAINTS : DEFAULT_CONSTRAINTS;
  const mergedConstraints = Array.from(new Set([...baseConstraints, ...userConstraints]));

  return {
    repo: path.resolve(repo.trim()),
    goal: goal.trim(),
    scope: normalizedScope,
    constraints: mergedConstraints,
    acceptance: normalizedAcceptance,
    reviewMode,
    taskKind: normalizeTaskKind(taskKind),
    agyPermissionPolicy: normalizeAgyPermissionPolicy(agyPermissionPolicy),
    defaultRunAutomatedTests: resolvedDefaultTests,
    maxRepairRounds,
    maxConsecutiveFailures,
    maxNoProgressRounds
  };
}

/**
 * 从 JSON 文件加载 WorkOrder
 */
export function loadWorkOrderFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('必须提供工作单文件路径');
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`工作单文件不存在：${resolved}`);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    throw new Error(`工作单 JSON 解析失败：${err.message}`);
  }

  if (!data || typeof data !== 'object') {
    throw new Error('工作单文件必须包含有效的 JSON 对象');
  }

  return planWork(data);
}

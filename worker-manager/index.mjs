import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { spawnManagedProcess, DEFAULT_WORKER_TIMEOUT_MS } from '../watchdog/index.mjs';
import { assertAntigravityTask, normalizeAgyPermissionPolicy } from '../router/execution-policy.mjs';

const SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function executionEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function failure(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, isSystemFailure: true, ...extra });
}

/** Keep only actual numeric counters; unknown accounting formats remain unknown. */
function numericUsage(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([key, count]) => !/^[a-z_]+$/.test(key) || !Number.isSafeInteger(count) || count < 0)) return null;
  return Object.fromEntries(entries);
}

export function probeAgyExecutable(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  const resolved = path.resolve(filePath);
  try {
    if (!fs.statSync(resolved).isFile()) return null;
    fs.accessSync(resolved, fs.constants.X_OK);
    const options = { env: executionEnvironment(), encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    const version = execFileSync(resolved, ['--version'], options).trim();
    // Go's flag package prints successful --help output to stderr.
    const helpResult = spawnSync(resolved, ['--help'], { ...options, shell: false });
    if (helpResult.error || helpResult.status !== 0 || helpResult.signal) return null;
    const help = (helpResult.stdout || '') + (helpResult.stderr || '');
    if (!version) return null;
    return {
      path: resolved,
      version,
      supportsConversation: help.includes('--conversation'),
      supportsOutputFormat: help.includes('--output-format'),
      supportsMode: help.includes('--mode'),
      supportsSandbox: help.includes('--sandbox'),
      supportsSkipPermissions: help.includes('--dangerously-skip-permissions'),
      supportsSettings: help.includes('--settings')
    };
  } catch {
    return null;
  }
}

export function detectAgyExecutable({ explicitPath } = {}) {
  const selected = explicitPath ?? process.env.SUPER_AGENT_AGY;
  if (selected !== undefined) {
    const info = probeAgyExecutable(selected);
    if (!info?.supportsOutputFormat || !info.supportsConversation || !info.supportsMode) {
      throw failure('ERR_AGY_UNSUPPORTED', '指定的 Antigravity CLI 不可执行或缺少 JSON、会话续用、受控编辑参数。');
    }
    return info;
  }
  const candidates = [path.join(os.homedir(), '.local', 'bin', 'agy'),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, 'agy'))];
  for (const candidate of new Set(candidates)) {
    const info = probeAgyExecutable(candidate);
    if (info?.supportsOutputFormat && info.supportsConversation && info.supportsMode) return info;
  }
  throw failure('ERR_AGY_UNSUPPORTED', '未找到支持 JSON、会话续用和受控编辑的 Antigravity CLI；请用 --agy 指定有效程序。');
}

export function parseDeliveryReport(rawResponse, acceptance, reviewMode, currentChecklist, currentRevision) {
  if (typeof rawResponse !== 'string' || !rawResponse.trim()) {
    return {
      ok: false,
      error: 'Worker 最终回复为空',
      report: null,
      validation: {
        valid: false,
        allImplemented: false,
        hasBlocked: false,
        hasIncomplete: true,
        blockedItems: [],
        incompleteItems: [],
        implementedItems: [],
        missingIds: acceptance ? acceptance.map(a => a.requirementId) : [],
        unknownIds: [],
        duplicateIds: [],
        issues: ['Worker 最终回复为空，未提供交付清单']
      }
    };
  }

  const trimmed = rawResponse.trim();
  let parsed = null;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (blockMatch) {
      try { parsed = JSON.parse(blockMatch[1].trim()); } catch {}
    }
    if (!parsed) {
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try { parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch {}
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'Worker 最终回复未能解析为有效 JSON 对象',
      report: null,
      validation: {
        valid: false,
        allImplemented: false,
        hasBlocked: false,
        hasIncomplete: true,
        blockedItems: [],
        incompleteItems: [],
        implementedItems: [],
        missingIds: acceptance ? acceptance.map(a => a.requirementId) : [],
        unknownIds: [],
        duplicateIds: [],
        issues: ['Worker 最终回复未能解析为有效 JSON 格式交付清单']
      }
    };
  }

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const launch = parsed.launch ?? (parsed['启动说明'] || null);
  const rawDelivery = parsed.delivery;

  const isDeliveryMode = (reviewMode === 'CODEX_DELIVERY_CHECK') ||
    (parsed.reportKind !== undefined) ||
    (currentRevision !== undefined && currentRevision > 0);

  const reportKind = parsed.reportKind
    ? String(parsed.reportKind).trim().toUpperCase()
    : ((currentRevision && currentRevision > 0) ? 'DELTA' : 'FULL');

  const baseRevision = Number.isInteger(parsed.baseRevision)
    ? parsed.baseRevision
    : (currentRevision ?? 0);

  if (!Array.isArray(rawDelivery)) {
    return {
      ok: false,
      error: '交付清单缺少 delivery 数组',
      report: { reportKind, baseRevision, summary, launch, delivery: [] },
      validation: {
        valid: false,
        allImplemented: false,
        hasBlocked: false,
        hasIncomplete: true,
        blockedItems: [],
        incompleteItems: [],
        implementedItems: [],
        missingIds: acceptance ? acceptance.map(a => a.requirementId) : [],
        unknownIds: [],
        duplicateIds: [],
        issues: ['交付清单缺少 delivery 数组']
      }
    };
  }

  const standardizedDelivery = [];
  const issues = [];
  const seenIds = new Set();
  const unknownIds = [];
  const duplicateIds = [];
  const blockedItems = [];
  const incompleteItems = [];
  const implementedItems = [];
  const expectedIds = Array.isArray(acceptance)
    ? new Set(acceptance.map(a => a.requirementId))
    : (Array.isArray(currentChecklist) ? new Set(currentChecklist.map(a => a.requirementId)) : null);

  for (let i = 0; i < rawDelivery.length; i++) {
    const item = rawDelivery[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push(`delivery[${i}] 必须是非空对象`);
      continue;
    }
    const reqId = typeof item.requirementId === 'string' ? item.requirementId.trim() : '';
    if (!reqId) {
      issues.push(`delivery[${i}] 缺少 requirementId`);
      continue;
    }
    if (seenIds.has(reqId)) {
      duplicateIds.push(reqId);
      issues.push(`delivery 存在重复的 requirementId: ${reqId}`);
      continue;
    }
    seenIds.add(reqId);

    if (expectedIds && !expectedIds.has(reqId)) {
      unknownIds.push(reqId);
      issues.push(`delivery 包含未知的 requirementId: ${reqId}`);
      continue;
    }

    let rawStatus = typeof item.status === 'string' ? item.status.trim().toUpperCase() : '';

    if (isDeliveryMode) {
      // 兼容映射旧格式
      if (rawStatus === 'IMPLEMENTED') rawStatus = 'READY_FOR_ACCEPTANCE';
      else if (rawStatus === 'INCOMPLETE') rawStatus = 'PARTIAL';

      if (['ACCEPTED', 'REJECTED'].includes(rawStatus)) {
        issues.push(`Worker 严禁自报 [${rawStatus}] 状态；需求 [${reqId}] 的最终验收/驳回权仅归属于用户`);
        continue;
      }

      if (!['TODO', 'IN_PROGRESS', 'PARTIAL', 'READY_FOR_ACCEPTANCE', 'BLOCKED'].includes(rawStatus)) {
        issues.push(`delivery[${reqId}] status 非法: ${item.status} (Worker 仅可设置 TODO/IN_PROGRESS/PARTIAL/READY_FOR_ACCEPTANCE/BLOCKED)`);
        continue;
      }
    } else {
      if (!['IMPLEMENTED', 'INCOMPLETE', 'BLOCKED'].includes(rawStatus)) {
        issues.push(`delivery[${reqId}] status 非法: ${item.status} (必须为 IMPLEMENTED/INCOMPLETE/BLOCKED)`);
        continue;
      }
    }

    const implementation = typeof item.implementation === 'string' ? item.implementation.trim() : '';
    const entry = typeof item.entry === 'string' ? item.entry.trim() : '';
    const expectedResult = typeof item.expectedResult === 'string' ? item.expectedResult.trim() : '';
    const changedFiles = Array.isArray(item.changedFiles)
      ? item.changedFiles.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim())
      : [];
    const noChangeReason = typeof item.noChangeReason === 'string' ? item.noChangeReason.trim() : null;
    const reason = typeof item.reason === 'string' ? item.reason.trim() : (typeof item.error === 'string' ? item.error.trim() : '');
    const unblockConditions = typeof item.unblockConditions === 'string' ? item.unblockConditions.trim() : (typeof item.conditions === 'string' ? item.conditions.trim() : '');
    const selfChecks = Array.isArray(item.selfChecks) ? item.selfChecks : [];
    const manualTestSteps = Array.isArray(item.manualTestSteps) ? item.manualTestSteps : [];
    const remainingWork = Array.isArray(item.remainingWork) ? item.remainingWork : [];
    const remainingIssues = Array.isArray(item.remainingIssues) ? item.remainingIssues : [];
    const satisfiedCriteria = Array.isArray(item.satisfiedCriteria) ? item.satisfiedCriteria : [];
    const blocker = item.blocker ?? null;
    const oldStatus = item.oldStatus ? String(item.oldStatus).trim().toUpperCase() : undefined;

    const record = {
      requirementId: reqId,
      status: rawStatus,
      implementation,
      entry,
      expectedResult,
      changedFiles,
      noChangeReason,
      selfChecks,
      manualTestSteps,
      remainingWork,
      remainingIssues,
      satisfiedCriteria,
      blocker,
      ...(oldStatus ? { oldStatus } : {}),
      ...(reason ? { reason } : {}),
      ...(unblockConditions ? { unblockConditions } : {})
    };

    if (rawStatus === 'BLOCKED') {
      if (!reason && !blocker?.reason) issues.push(`delivery[${reqId}] 处于 BLOCKED 状态，但未说明具体 reason`);
      if (!unblockConditions && !blocker?.requiredAssistance) issues.push(`delivery[${reqId}] 处于 BLOCKED 状态，但未说明待处理条件`);
      blockedItems.push(record);
    } else if (rawStatus === 'INCOMPLETE' || rawStatus === 'PARTIAL' || rawStatus === 'TODO' || rawStatus === 'IN_PROGRESS') {
      incompleteItems.push(record);
    } else if (rawStatus === 'IMPLEMENTED' || rawStatus === 'READY_FOR_ACCEPTANCE') {
      if (!implementation) issues.push(`delivery[${reqId}] 缺少 implementation 实现说明`);
      if (isDeliveryMode) {
        if (!expectedResult) issues.push(`delivery[${reqId}] 缺少 expectedResult 预期结果`);
        if (changedFiles.length === 0 && !noChangeReason) issues.push(`delivery[${reqId}] 缺少 changedFiles 或 noChangeReason`);
        if (manualTestSteps.length === 0) issues.push(`delivery[${reqId}] 缺少 manualTestSteps 手动测试步骤`);
        if (remainingWork.length > 0) issues.push(`delivery[${reqId}] 处于就绪状态但声明了 remainingWork`);
        if (blocker) issues.push(`delivery[${reqId}] 处于就绪状态但声明了 blocker`);
      } else {
        if (!entry) issues.push(`delivery[${reqId}] 缺少 entry 功能入口`);
        if (!expectedResult) issues.push(`delivery[${reqId}] 缺少 expectedResult 预期结果`);
        if (changedFiles.length === 0) issues.push(`delivery[${reqId}] 缺少 changedFiles 修改文件列表`);
      }
      implementedItems.push(record);
    }

    standardizedDelivery.push(record);
  }

  const missingIds = [];
  if (expectedIds && (!isDeliveryMode || reportKind === 'FULL')) {
    for (const expId of expectedIds) {
      if (!seenIds.has(expId)) {
        missingIds.push(expId);
        issues.push(`验收项 ${expId} 未在 delivery 交付清单中提供`);
      }
    }
  }

  const valid = issues.length === 0 && missingIds.length === 0 && unknownIds.length === 0 && duplicateIds.length === 0;
  const hasBlocked = blockedItems.length > 0;
  const allImplemented = valid && !hasBlocked && incompleteItems.length === 0 &&
    (expectedIds ? standardizedDelivery.length === expectedIds.size : standardizedDelivery.length > 0) &&
    standardizedDelivery.every(d => ['IMPLEMENTED', 'READY_FOR_ACCEPTANCE'].includes(d.status));
  const hasIncomplete = !allImplemented && !hasBlocked;

  return {
    ok: true,
    report: {
      reportKind,
      baseRevision,
      summary,
      launch,
      delivery: standardizedDelivery
    },
    validation: {
      valid,
      allImplemented,
      hasBlocked,
      hasIncomplete,
      blockedItems,
      incompleteItems,
      implementedItems,
      missingIds,
      unknownIds,
      duplicateIds,
      issues
    }
  };
}

/** Build fixed session-only arguments without starting a CLI or changing settings. */
export function buildAntigravityArgs({ info, prompt, conversationId, agyPermissionPolicy = 'AUTO_APPROVE' }) {
  if (!info?.supportsOutputFormat || !info.supportsConversation || !info.supportsMode) {
    throw failure('ERR_AGY_UNSUPPORTED', 'Antigravity CLI 缺少必需的 JSON、会话或编辑模式参数。');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw failure('ERR_AGY_INPUT', 'Worker 任务提示不能为空。');
  if (conversationId !== undefined && conversationId !== null && (typeof conversationId !== 'string' || !SESSION_ID.test(conversationId))) {
    throw failure('ERR_AGY_CONVERSATION', 'Worker 会话 ID 格式无效，拒绝启动或隐式更换会话。');
  }
  const policy = normalizeAgyPermissionPolicy(agyPermissionPolicy);
  const args = ['-p', prompt, '--output-format', 'json', '--mode', 'accept-edits'];
  if (policy === 'AUTO_APPROVE') {
    if (!info.supportsSkipPermissions || !info.supportsSandbox || !info.supportsSettings) {
      throw failure('ERR_AGY_PERMISSION_CAPABILITY', 'AUTO_APPROVE 需要 CLI 同时支持会话自动批准、终端隔离及会话设置；已停止，未降低隔离或修改全局权限。');
    }
    args.push('--dangerously-skip-permissions', '--sandbox', '--settings', JSON.stringify({ allowNonWorkspaceAccess: false }));
  } else if (info.supportsSandbox) {
    args.push('--sandbox');
  }
  if (conversationId) args.push('--conversation', conversationId);
  return args;
}

/** A successful CLI turn is only a Worker result, never a review decision. */
export async function runAntigravity({
  executable,
  cwd,
  prompt,
  conversationId,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  onChildSpawned,
  acceptance,
  reviewMode,
  currentChecklist,
  currentRevision,
  workOrder,
  agyPermissionPolicy
}) {
  // Check ownership before even probing the vendor executable, including old plans.
  assertAntigravityTask(workOrder);
  const info = probeAgyExecutable(executable);
  const permissionPolicy = normalizeAgyPermissionPolicy(workOrder.agyPermissionPolicy);
  if (agyPermissionPolicy !== undefined && normalizeAgyPermissionPolicy(agyPermissionPolicy) !== permissionPolicy) {
    throw failure('ERR_AGY_PERMISSION_POLICY', '调用权限策略与已登记工作单不一致，拒绝隐式扩大权限。');
  }
  const args = buildAntigravityArgs({ info, prompt, conversationId, agyPermissionPolicy: permissionPolicy });
  const processResult = await spawnManagedProcess({
    executable: info.path, args, cwd, timeoutMs, env: executionEnvironment(),
    onSpawn: (pid, pgid) => onChildSpawned?.(pid, pgid)
  });
  let data;
  try { data = JSON.parse(processResult.stdout); }
  catch { throw failure('ERR_AGY_PROTOCOL', 'Antigravity 没有返回完整、可解析的 JSON 结果。'); }
  const usage = numericUsage(data?.usage);
  const parsedFailure = (code, message, extra = {}) => failure(code, message, { usage, ...extra });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw parsedFailure('ERR_AGY_PROTOCOL', 'Antigravity 返回了非对象结果。');
  if (data.denied_actions !== undefined && !Array.isArray(data.denied_actions)) throw parsedFailure('ERR_AGY_PROTOCOL', 'Antigravity 权限结果格式未知。');
  if (data.denied_actions?.length) {
    throw parsedFailure('ERR_AGY_PERMISSION', `Worker 有 ${data.denied_actions.length} 项操作被权限控制拒绝；保留成果并等待人工处理。`, { isPermissionDenied: true });
  }
  if (data.status !== 'SUCCESS') throw parsedFailure('ERR_AGY_STATUS', 'Antigravity 未报告成功完成；不将外部状态当作代码审查通过。');
  const returnedId = data.conversation_id ?? null;
  if (returnedId === null) throw parsedFailure('ERR_AGY_CONVERSATION', 'Antigravity 首次成功结果缺少会话 ID，无法保证原会话返工，已停止推进审查。');
  if (returnedId !== null && (typeof returnedId !== 'string' || !SESSION_ID.test(returnedId))) {
    throw parsedFailure('ERR_AGY_CONVERSATION', 'Antigravity 返回的会话 ID 格式无效。');
  }
  if (conversationId && returnedId !== conversationId) {
    throw parsedFailure('ERR_AGY_CONVERSATION', 'Antigravity 未确认继续原 Worker 会话，拒绝静默使用新会话。');
  }
  if (data.response !== undefined && data.response !== null && typeof data.response !== 'string') {
    throw parsedFailure('ERR_AGY_PROTOCOL', 'Antigravity 摘要字段格式未知。');
  }
  const rawResponse = typeof data.response === 'string' ? data.response : '';
  const parsedDelivery = parseDeliveryReport(rawResponse, acceptance, reviewMode, currentChecklist, currentRevision);
  return {
    cliStatus: data.status,
    conversationId: returnedId,
    responseSummary: rawResponse.slice(0, 3000),
    delivery: parsedDelivery.report?.delivery ?? null,
    deliveryReport: parsedDelivery.report ?? null,
    deliveryValidation: parsedDelivery.validation ?? null,
    usage
  };
}

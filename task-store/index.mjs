import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { processGroupLiveness } from '../watchdog/index.mjs';
import { initDeliveryChecklist } from './delivery-workflow.mjs';
export * from './delivery-workflow.mjs';

const SCHEMA_VERSION = 5;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const HASH = /^[a-f0-9]{64}$/;
const VALID_STATUSES = new Set(['CREATED', 'RUNNING', 'AWAITING_CODEX_REVIEW', 'AWAITING_LAUNCH_CHECK', 'AWAITING_FUNCTIONAL_CHECK', 'READY_FOR_USER_TEST', 'REVIEWING', 'CHANGES_REQUESTED', 'FAILED', 'PASSED', 'BLOCKED', 'AWAITING_USER_ACCEPTANCE', 'ACCEPTED']);
const TASK_KEYS = new Set(['schemaVersion', 'id', 'status', 'failurePhase', 'repairIntent', 'plan', 'baseCommit', 'createdAt', 'updatedAt', 'attempts', 'repairRounds', 'consecutiveFailures', 'conversationId', 'worktreePath', 'snapshotHash', 'owner', 'activeChild', 'findings', 'review', 'reviewHistory', 'executionHistory', 'workerResult', 'error', 'blockedReason', 'startupCheck', 'startupHistory', 'functionalCheck', 'functionalHistory', 'deliveryChecklist', 'deliveryRevision', 'deliveryHistory', 'acceptanceHistory', 'unblockHistory']);

function fail(message) { throw new Error(message); }
function plain(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`${name} 必须是普通对象`);
}
function keys(value, allowed, name) {
  plain(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} 含未知字段：${key}`);
}
function required(value, names, label) {
  for (const name of names) if (!Object.hasOwn(value, name) || value[name] === undefined) fail(`${label} 缺少字段：${name}`);
}
function text(value, name, { empty = false, max = 100000 } = {}) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || value.includes('\0')) fail(`${name} 必须为有效字符串`);
}
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} 必须为 ${min} 至 ${max} 的整数`);
}
function date(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${name} 必须为规范 ISO 时间`);
}
function relativePath(value, name, { scope = false } = {}) {
  text(value, name, { max: 4096 });
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) fail(`${name} 包含绝对路径或路径穿越`);
  if (!scope && (value === '.' || value === './' || value.endsWith('/'))) fail(`${name} 必须指向文件`);
}
function strings(value, name, { allowEmpty = true, paths = false, scope = false, unique = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) fail(`${name} 必须为${allowEmpty ? '' : '非空'}数组`);
  const seen = new Set();
  for (const item of value) {
    if (paths) relativePath(item, name, { scope }); else text(item, name);
    if (unique && seen.has(item)) fail(`${name} 有重复项`);
    seen.add(item);
  }
}
function usage(value, name = 'usage', depth = 0) {
  if (value === null) return;
  plain(value, name);
  if (depth > 3) fail(`${name} 层级过深`);
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) fail(`${name} 统计字段非法`);
    if (item && typeof item === 'object' && !Array.isArray(item)) usage(item, name, depth + 1);
    else if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) fail(`${name} 必须仅包含非负数值统计`);
  }
}
function conversation(value, name) {
  if (value !== null) { text(value, name, { max: 512 }); if (/[\r\n]/.test(value)) fail(`${name} 不能含换行`); }
}
function validatePlan(plan) {
  keys(plan, ['repo', 'goal', 'scope', 'constraints', 'acceptance', 'reviewMode', 'defaultRunAutomatedTests', 'maxRepairRounds', 'maxConsecutiveFailures', 'maxNoProgressRounds', 'taskKind', 'agyPermissionPolicy'], 'plan');
  required(plan, ['repo', 'goal', 'scope', 'constraints', 'acceptance', 'reviewMode', 'defaultRunAutomatedTests', 'maxRepairRounds', 'maxConsecutiveFailures'], 'plan');
  text(plan.repo, 'plan.repo', { max: 4096 });
  if (!path.isAbsolute(plan.repo)) fail('plan.repo 必须为绝对路径');
  text(plan.goal, 'plan.goal');
  if (plan.taskKind !== undefined && !['DEVELOPMENT', 'RELEASE'].includes(plan.taskKind)) fail('plan.taskKind 非法');
  if (plan.agyPermissionPolicy !== undefined && !['AUTO_APPROVE', 'STANDARD'].includes(plan.agyPermissionPolicy)) fail('plan.agyPermissionPolicy 非法');
  strings(plan.scope, 'plan.scope', { allowEmpty: false, paths: true, scope: true, unique: true });
  strings(plan.constraints, 'plan.constraints', { allowEmpty: false, unique: true });
  integer(plan.maxRepairRounds, 'plan.maxRepairRounds', 0, 5);
  integer(plan.maxConsecutiveFailures, 'plan.maxConsecutiveFailures', 1, 5);
  if (plan.maxNoProgressRounds !== undefined) integer(plan.maxNoProgressRounds, 'plan.maxNoProgressRounds', 1, 5);
  if (plan.reviewMode === 'CODEX_DELIVERY_CHECK') {
    if (typeof plan.defaultRunAutomatedTests !== 'boolean') fail('CODEX_DELIVERY_CHECK 的 defaultRunAutomatedTests 必须为布尔值');
  } else {
    if (plan.defaultRunAutomatedTests !== false || !['CODEX_FUNCTIONAL_CHECK', 'CODEX_STARTUP_CHECK', 'CODEX_SEMANTIC_CODE_REVIEW'].includes(plan.reviewMode)) fail('plan 的审查模式或默认测试设置非法');
  }
  if (!Array.isArray(plan.acceptance) || plan.acceptance.length === 0) fail('plan.acceptance 必须为非空数组');
  const ids = new Set();
  for (const item of plan.acceptance) {
    keys(item, ['requirementId', 'requirement', 'codeEvidenceExpected', 'acceptanceCriteria', 'parentRequirementId', 'dependsOn'], 'acceptance');
    required(item, ['requirementId', 'requirement'], 'acceptance');
    text(item.requirementId, 'requirementId', { max: 256 });
    if (item.requirementId !== item.requirementId.trim() || ids.has(item.requirementId)) fail('acceptance 的 ID 非规范或重复');
    ids.add(item.requirementId);
    text(item.requirement, 'requirement');
    if (item.codeEvidenceExpected !== undefined) text(item.codeEvidenceExpected, 'codeEvidenceExpected');
    if (item.acceptanceCriteria !== undefined) strings(item.acceptanceCriteria, 'acceptanceCriteria', { allowEmpty: false });
    if (item.parentRequirementId !== undefined && item.parentRequirementId !== null) text(item.parentRequirementId, 'parentRequirementId', { max: 256 });
    if (item.dependsOn !== undefined) strings(item.dependsOn, 'dependsOn', { allowEmpty: true });
  }
}
function validateOwner(owner) {
  keys(owner, ['pid', 'host', 'startedAt'], 'owner');
  required(owner, ['pid', 'host', 'startedAt'], 'owner');
  integer(owner.pid, 'owner.pid', 1);
  text(owner.host, 'owner.host', { max: 256 });
  date(owner.startedAt, 'owner.startedAt');
}
function validateChild(child) {
  keys(child, ['status', 'pid', 'pgid', 'host', 'type', 'startedAt'], 'activeChild');
  required(child, ['status', 'host', 'type', 'startedAt'], 'activeChild');
  text(child.host, 'activeChild.host', { max: 256 });
  date(child.startedAt, 'activeChild.startedAt');
  if (!['worker', 'reviewer', 'manual'].includes(child.type)) fail('activeChild.type 非法');
  if (!['NOT_STARTED', 'SPAWNING', 'RUNNING'].includes(child.status)) fail('activeChild.status 非法');
  if (child.status === 'RUNNING') {
    integer(child.pid, 'activeChild.pid', 1);
    integer(child.pgid, 'activeChild.pgid', 1);
    if (child.pid !== child.pgid || child.type === 'manual') fail('activeChild 的进程组身份非法');
  } else if (Object.hasOwn(child, 'pid') || Object.hasOwn(child, 'pgid')) fail('未登记进程不能包含 pid/pgid');
  if ((child.type === 'manual') !== (child.status === 'NOT_STARTED')) fail('manual 只允许明确 NOT_STARTED');
}
function validateFinding(item) {
  keys(item, ['severity', 'path', 'location', 'problem', 'impact', 'requestedFix'], 'finding');
  required(item, ['severity', 'path', 'location', 'problem', 'impact', 'requestedFix'], 'finding');
  if (!['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(item.severity)) fail('finding.severity 非法');
  relativePath(item.path, 'finding.path');
  for (const k of ['location', 'problem', 'impact', 'requestedFix']) text(item[k], `finding.${k}`);
}
function validateFindings(value) {
  if (!Array.isArray(value)) fail('findings 必须为数组');
  for (const item of value) validateFinding(item);
}
function validateCoverage(value, plan) {
  if (!Array.isArray(value)) fail('requirementCoverage 必须为数组');
  const expected = new Set(plan.acceptance.map(a => a.requirementId));
  const seen = new Set();
  for (const item of value) {
    keys(item, ['requirementId', 'decision', 'evidence'], 'coverage');
    required(item, ['requirementId', 'decision', 'evidence'], 'coverage');
    if (!expected.has(item.requirementId) || seen.has(item.requirementId)) fail('coverage ID 未知或重复');
    seen.add(item.requirementId);
    if (!['SATISFIED', 'PARTIAL', 'MISSING', 'UNKNOWN'].includes(item.decision) || !Array.isArray(item.evidence)) fail('coverage 结构非法');
    if (item.decision === 'SATISFIED' && item.evidence.length === 0) fail('SATISFIED 缺少证据');
    for (const evidence of item.evidence) {
      keys(evidence, ['path', 'location', 'explanation'], 'evidence');
      required(evidence, ['path', 'location', 'explanation'], 'evidence');
      relativePath(evidence.path, 'evidence.path');
      text(evidence.location, 'evidence.location');
      text(evidence.explanation, 'evidence.explanation');
    }
  }
  if (seen.size !== expected.size) fail('coverage 未覆盖全部验收项');
}
function validateReview(record, task, allowFailure = false) {
  plain(record, 'review');
  const failure = record.decision === 'FAILED' && allowFailure;
  keys(record, failure ? ['decision', 'error', 'usage', 'durationMs', 'reviewedAt', 'reviewerType'] :
    ['decision', 'requirementCoverage', 'findings', 'reviewedFiles', 'runtimeUnknowns', 'summary', 'usage', 'snapshotHash', 'durationMs', 'reviewedAt', 'reviewerType', 'taskId', 'baseCommit'], 'review');
  required(record, ['decision'], 'review');
  if (record.durationMs !== undefined) integer(record.durationMs, 'durationMs');
  if (record.usage !== undefined) usage(record.usage);
  if (record.taskId !== undefined && record.taskId !== task.id) fail('review.taskId 错绑');
  if (record.baseCommit !== undefined && record.baseCommit !== task.baseCommit) fail('review.baseCommit 错绑');
  if (failure) {
    required(record, ['reviewedAt', 'reviewerType', 'durationMs', 'usage', 'error'], 'failedReview');
    date(record.reviewedAt, 'failedReview.reviewedAt');
    text(record.reviewerType, 'failedReview.reviewerType', { max: 128 });
    text(record.error, 'review.error');
    return;
  }
  required(record, ['reviewedAt', 'reviewerType'], 'review');
  date(record.reviewedAt, 'reviewedAt');
  text(record.reviewerType, 'reviewerType', { max: 128 });
  if (!['PASS', 'CHANGES_REQUESTED', 'BLOCKED'].includes(record.decision)) fail('review.decision 非法');
  required(record, ['requirementCoverage', 'findings', 'reviewedFiles', 'runtimeUnknowns', 'summary', 'snapshotHash'], 'review');
  if (!HASH.test(record.snapshotHash)) fail('review.snapshotHash 非法');
  validateCoverage(record.requirementCoverage, task.plan);
  validateFindings(record.findings);
  strings(record.reviewedFiles, 'reviewedFiles', { paths: true, unique: true });
  strings(record.runtimeUnknowns, 'runtimeUnknowns');
  text(record.summary, 'review.summary');
  if (record.decision === 'PASS' && (record.requirementCoverage.some(c => c.decision !== 'SATISFIED') || record.findings.some(f => ['CRITICAL', 'HIGH'].includes(f.severity)))) fail('PASS 包含未满足需求或阻塞问题');
  if (record.decision === 'CHANGES_REQUESTED' && record.findings.length === 0) fail('CHANGES_REQUESTED 缺少具体发现');
}
function validateExecution(record) {
  keys(record, ['attempt', 'type', 'status', 'durationMs', 'usage', 'recordedAt', 'error', 'code', 'decision'], 'executionHistory');
  required(record, ['type', 'status', 'durationMs', 'recordedAt', 'usage'], 'executionHistory');
  if (record.attempt !== undefined) integer(record.attempt, 'execution.attempt', 1);
  integer(record.durationMs, 'execution.durationMs');
  date(record.recordedAt, 'execution.recordedAt');
  if (!['WORKER', 'REVIEWER'].includes(record.type) || !['SUCCESS', 'FAILED'].includes(record.status)) fail('execution 结果非法');
  if (record.status === 'FAILED') text(record.error, 'execution.error');
  if (record.code !== undefined) text(record.code, 'execution.code', { max: 128 });
  if (record.decision !== undefined && !['PASS', 'CHANGES_REQUESTED', 'BLOCKED', 'FAILED'].includes(record.decision)) fail('execution.decision 非法');
  if (record.status === 'SUCCESS' && record.usage === undefined) fail('execution 缺少真实 usage（无统计时使用 null）');
  if (record.usage !== undefined) usage(record.usage);
}
function validateWorkerResult(result) {
  keys(result, ['cliStatus', 'conversationId', 'responseSummary', 'usage', 'processGroupExited', 'childPid', 'pgid', 'delivery', 'deliveryReport', 'deliveryValidation'], 'workerResult');
  required(result, ['cliStatus', 'conversationId', 'responseSummary', 'usage'], 'workerResult');
  if (result.cliStatus !== 'SUCCESS') fail('workerResult.cliStatus 非法');
  conversation(result.conversationId, 'workerResult.conversationId');
  text(result.responseSummary, 'workerResult.responseSummary', { empty: true, max: 20000 });
  usage(result.usage);
  if (result.processGroupExited !== undefined && result.processGroupExited !== true) fail('workerResult 的进程组尚未退出');
  for (const k of ['childPid', 'pgid']) if (result[k] !== undefined) integer(result[k], `workerResult.${k}`, 1);
}

function canonicalFuturePath(input) {
  let existing = path.resolve(input);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) fail('无法解析状态根目录');
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) fail('状态根的现有祖先必须是目录');
  return path.join(fs.realpathSync(existing), ...missing);
}
function storageDirectoryCheck(directory) {
  if (!fs.existsSync(directory)) return;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`状态目录不是独立普通目录：${directory}`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail(`状态目录不属于当前用户：${directory}`);
}
export function getStoragePaths(explicitRoot) {
  const chosen = explicitRoot ?? process.env.SUPER_AGENT_HOME ?? path.join(os.homedir(), '.codex', 'super-agent');
  text(chosen, 'state-root', { max: 4096 });
  const rootDir = canonicalFuturePath(chosen);
  const stateDir = path.join(rootDir, '.state');
  const workspacesDir = path.join(rootDir, '.workspaces');
  storageDirectoryCheck(stateDir);
  storageDirectoryCheck(workspacesDir);
  return { rootDir, stateDir, workspacesDir };
}
export function initStorage(explicitRoot) {
  const paths = getStoragePaths(explicitRoot);
  for (const directory of [paths.stateDir, paths.workspacesDir]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    storageDirectoryCheck(directory);
    fs.chmodSync(directory, 0o700);
  }
}
function taskPath(id, stateDir, extension) {
  if (typeof id !== 'string' || !UUID.test(id)) fail('非法任务 UUID');
  return path.join(stateDir, `${id}.${extension}`);
}
function readPrivateJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('状态文件不是普通文件');
  if (stat.size > 16 * 1024 * 1024) fail('状态文件超过安全读取上限');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('状态文件不属于当前用户');
  if ((stat.mode & 0o077) !== 0) fail('状态文件权限必须限制为当前用户访问');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function validateLock(lock) {
  keys(lock, ['pid', 'token', 'lockedAt', 'host'], 'lock');
  required(lock, ['pid', 'token', 'lockedAt', 'host'], 'lock');
  integer(lock.pid, 'lock.pid', 1);
  if (typeof lock.token !== 'string' || !UUID.test(lock.token)) fail('lock.token 非法');
  text(lock.host, 'lock.host', { max: 256 });
  date(lock.lockedAt, 'lock.lockedAt');
}
function withMutationGate(taskId, stateRoot, action) {
  initStorage(stateRoot);
  const { stateDir } = getStoragePaths(stateRoot);
  const file = taskPath(taskId, stateDir, 'gate');
  const gate = { pid: process.pid, token: randomUUID(), lockedAt: new Date().toISOString(), host: os.hostname() };
  try { fs.writeFileSync(file, JSON.stringify(gate), { mode: 0o600, flag: 'wx' }); }
  catch (err) {
    if (err.code === 'EEXIST') fail(`任务的短时 Gate 已存在；拒绝自动接管，请人工核实 ${file}`);
    throw err;
  }
  try {
    const result = action();
    if (result?.then) fail('Mutation Gate 内的动作必须同步');
    return result;
  } finally {
    const current = readPrivateJson(file);
    validateLock(current);
    if (current.token !== gate.token) fail('Mutation Gate 所有权变化，拒绝删除');
    fs.unlinkSync(file);
  }
}
export function checkProcessLiveness(pid, host) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || host !== os.hostname()) return 'UNKNOWN';
  try { process.kill(pid, 0); return 'ALIVE'; }
  catch (err) { return err.code === 'ESRCH' ? 'DEAD' : err.code === 'EPERM' ? 'ALIVE' : 'UNKNOWN'; }
}
export function acquireTaskLock(taskId, explicitRoot) {
  return withMutationGate(taskId, explicitRoot, () => {
    const { stateDir } = getStoragePaths(explicitRoot);
    const file = taskPath(taskId, stateDir, 'lock');
    const lock = { pid: process.pid, token: randomUUID(), lockedAt: new Date().toISOString(), host: os.hostname() };
    try { fs.writeFileSync(file, JSON.stringify(lock), { mode: 0o600, flag: 'wx' }); }
    catch (err) {
      if (err.code === 'EEXIST') fail(`任务 ${taskId} 已有锁；请等待原进程退出或显式 recover`);
      throw err;
    }
    return lock.token;
  });
}
export function releaseTaskLock(taskId, explicitRoot, lockToken) {
  if (typeof lockToken !== 'string' || !UUID.test(lockToken)) fail('释放锁缺少有效 token');
  return withMutationGate(taskId, explicitRoot, () => {
    const { stateDir } = getStoragePaths(explicitRoot);
    const file = taskPath(taskId, stateDir, 'lock');
    const lock = readPrivateJson(file);
    validateLock(lock);
    if (lock.token !== lockToken || lock.pid !== process.pid || lock.host !== os.hostname()) fail('任务锁所有权不匹配，拒绝删除');
    fs.unlinkSync(file);
  });
}
export async function withTaskLock(taskId, explicitRoot, action) {
  // An invalid/missing task never creates an otherwise unrecoverable orphan lock.
  loadTask(taskId, explicitRoot);
  const token = acquireTaskLock(taskId, explicitRoot);
  let retain = false;
  let actionError = null;
  try { return await action(); }
  catch (err) { actionError = err; retain = Boolean(err.processGroupUnconfirmed); throw err; }
  finally {
    // An unexpected failure between spawn and final persistence also keeps the task locked.
    try {
      const task = loadTask(taskId, explicitRoot);
      if (task.activeChild && ['SPAWNING', 'RUNNING'].includes(task.activeChild.status)) retain = true;
    } catch { retain = true; }
    if (!retain) {
      try { releaseTaskLock(taskId, explicitRoot, token); }
      catch (err) { if (actionError) actionError.lockReleaseError = err.message; else throw err; }
    }
  }
}
export function newTask(plan, baseCommit) {
  const now = new Date().toISOString();
  const isDeliveryMode = plan.reviewMode === 'CODEX_DELIVERY_CHECK';
  return {
    schemaVersion: isDeliveryMode ? 5 : 4,
    id: randomUUID(),
    status: 'CREATED',
    failurePhase: null,
    repairIntent: false,
    plan,
    baseCommit,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    repairRounds: 0,
    consecutiveFailures: 0,
    conversationId: null,
    worktreePath: null,
    snapshotHash: null,
    owner: null,
    activeChild: null,
    findings: [],
    review: null,
    reviewHistory: [],
    executionHistory: [],
    workerResult: null,
    startupCheck: null,
    startupHistory: [],
    functionalCheck: null,
    functionalHistory: [],
    ...(isDeliveryMode ? {
      deliveryChecklist: initDeliveryChecklist(plan.acceptance),
      deliveryRevision: 0,
      deliveryHistory: [],
      acceptanceHistory: [],
      unblockHistory: []
    } : {})
  };
}

/** Only records an actual opening observation; it makes no claim about code or business correctness. */
export function validateStartupCheck(check, task, historical = false) {
  const names = ['taskId', 'workerAttempt', 'worktreePath', 'kind', 'target', 'outcome', 'errors', 'evidence', 'observedAt', 'verificationScope', 'checkedBy'];
  keys(check, names, 'startupCheck'); required(check, names, 'startupCheck');
  if (check.taskId !== task.id || check.worktreePath !== task.worktreePath) fail('启动记录与任务或工作树不一致');
  integer(check.workerAttempt, 'startupCheck.workerAttempt', 1);
  if (check.workerAttempt > task.attempts || (!historical && check.workerAttempt !== task.attempts)) fail('启动记录不是当前编码轮次');
  if (!['web', 'app', 'unknown'].includes(check.kind)) fail('启动目标类型非法');
  if (!['OPENED', 'STARTUP_FAILED', 'NOT_VERIFIED'].includes(check.outcome)) fail('启动检查结果非法');
  if (check.verificationScope !== 'STARTUP_ONLY' || check.checkedBy !== 'CODEX_CURRENT_SESSION') fail('仅接受当前Codex的启动打开观察');
  text(check.evidence, '启动观察证据', { max: 20000 }); date(check.observedAt, '启动观察时间');
  strings(check.errors, '启动错误');
  if (check.target !== null) text(check.target, '启动目标', { max: 4096 });
  if (check.outcome !== 'NOT_VERIFIED') {
    if (check.kind === 'unknown' || check.target === null) fail('打开或启动失败记录必须明确目标');
    if (check.kind === 'web') {
      let url; try { url = new URL(check.target); } catch { fail('测试网页地址无效'); }
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) fail('不支持的测试网页协议');
    }
  }
  if (check.outcome === 'OPENED' && check.errors.length) fail('仍有启动错误不能记录正常打开');
  if (check.outcome === 'STARTUP_FAILED' && !check.errors.length) fail('启动失败必须记录实际启动错误');
  return true;
}

/** Records Codex functional check by item; separates worker claims from user acceptance. */
export function validateFunctionalCheck(check, task, historical = false) {
  plain(check, 'functionalCheck');
  const names = ['taskId', 'workerAttempt', 'worktreePath', 'outcome', 'items', 'startup', 'summary', 'observedAt', 'verificationScope', 'checkedBy'];
  keys(check, [...names, 'errors'], 'functionalCheck');
  required(check, ['taskId', 'workerAttempt', 'worktreePath', 'outcome', 'items', 'summary', 'observedAt', 'verificationScope', 'checkedBy'], 'functionalCheck');
  if (check.taskId !== task.id || check.worktreePath !== task.worktreePath) fail('功能确认记录与任务或工作树不一致');
  integer(check.workerAttempt, 'functionalCheck.workerAttempt', 1);
  if (check.workerAttempt > task.attempts || (!historical && check.workerAttempt !== task.attempts)) fail('功能确认记录不是当前编码轮次');
  if (!['PASSED', 'FUNCTIONAL_FAILED', 'NOT_VERIFIED', 'BLOCKED'].includes(check.outcome)) fail('功能确认结果非法');
  if (check.verificationScope !== 'FUNCTIONAL_CHECK' || check.checkedBy !== 'CODEX_CURRENT_SESSION') fail('仅接受当前 Codex 的逐项功能确认');
  text(check.summary, 'functionalCheck.summary', { max: 20000 });
  date(check.observedAt, 'functionalCheck.observedAt');
  if (!Array.isArray(check.items)) fail('functionalCheck.items 必须为数组');

  const expectedIds = new Set(task.plan.acceptance.map(a => a.requirementId));
  const seenIds = new Set();
  let hasFail = false;
  let hasNotVerified = false;
  let hasBlocked = false;

  for (let i = 0; i < check.items.length; i++) {
    const item = check.items[i];
    plain(item, `functionalCheck.items[${i}]`);
    const itemAllowed = ['requirementId', 'result', 'codeEvidence', 'action', 'expected', 'observed', 'error', 'reason'];
    for (const k of Object.keys(item)) if (!itemAllowed.includes(k)) fail(`functionalCheck item 含未知字段：${k}`);
    required(item, ['requirementId', 'result', 'codeEvidence', 'action', 'expected', 'observed'], `functionalCheck item[${i}]`);
    text(item.requirementId, `item[${i}].requirementId`);
    if (!expectedIds.has(item.requirementId)) fail(`功能确认包含未知的 requirementId: ${item.requirementId}`);
    if (seenIds.has(item.requirementId)) fail(`功能确认包含重复的 requirementId: ${item.requirementId}`);
    seenIds.add(item.requirementId);

    if (!['PASS', 'FAIL', 'NOT_VERIFIED', 'BLOCKED'].includes(item.result)) fail(`item[${item.requirementId}].result 非法`);
    text(item.codeEvidence, `item[${item.requirementId}].codeEvidence`);
    text(item.action, `item[${item.requirementId}].action`);
    text(item.expected, `item[${item.requirementId}].expected`);
    text(item.observed, `item[${item.requirementId}].observed`);

    if (item.result === 'FAIL') {
      hasFail = true;
      if (!item.error && !item.reason) fail(`item[${item.requirementId}] 为 FAIL 时必须提供 error 或 reason`);
    } else if (item.result === 'NOT_VERIFIED') {
      hasNotVerified = true;
      if (!item.reason) fail(`item[${item.requirementId}] 为 NOT_VERIFIED 时必须提供 reason`);
    } else if (item.result === 'BLOCKED') {
      hasBlocked = true;
      if (!item.reason) fail(`item[${item.requirementId}] 为 BLOCKED 时必须提供 reason`);
    }
  }

  if (seenIds.size !== expectedIds.size) fail('功能确认未完整覆盖任务验收项');

  if (check.startup !== undefined && check.startup !== null) {
    plain(check.startup, 'functionalCheck.startup');
    for (const k of Object.keys(check.startup)) if (!['kind', 'target', 'opened', 'error', 'errors', 'output'].includes(k)) fail(`functionalCheck.startup 含未知字段：${k}`);
    if (check.startup.kind !== undefined && !['web', 'app', 'cli', 'config'].includes(check.startup.kind)) fail('functionalCheck.startup.kind 非法（仅支持 web/app/cli/config）');
    if (check.startup.opened !== undefined && typeof check.startup.opened !== 'boolean') fail('startup.opened 必须是布尔值');
    if (check.startup.target !== undefined && check.startup.target !== null) text(check.startup.target, 'startup.target', { max: 4096 });
    if (check.startup.errors !== undefined) strings(check.startup.errors, 'startup.errors');
    if (check.startup.error !== undefined && check.startup.error !== null) text(check.startup.error, 'startup.error');
    if (check.startup.output !== undefined && check.startup.output !== null) text(check.startup.output, 'startup.output', { empty: true, max: 20000 });
  }

  const startupError = check.startup && (
    check.startup.opened === false ||
    (Array.isArray(check.startup.errors) && check.startup.errors.length > 0) ||
    Boolean(check.startup.error)
  );

  if (check.outcome === 'PASSED') {
    if (!check.startup || typeof check.startup !== 'object') fail('PASSED 必须包含真实的 startup 对象');
    if (!['web', 'app', 'cli', 'config'].includes(check.startup.kind)) fail('PASSED startup.kind 必须为 web/app/cli/config 之一');
    if (typeof check.startup.target !== 'string' || !check.startup.target.trim()) fail('PASSED startup.target 必须为真实非空目标');
    if (check.startup.kind === 'web') {
      let url;
      try { url = new URL(check.startup.target); } catch { fail('测试网页地址无效'); }
      if (!['http:', 'https:', 'file:'].includes(url.protocol)) fail('不支持的测试网页协议');
    }
    if (check.startup.opened !== true) fail('PASSED 必须确认目标已正常启动/打开 (opened 必须为 true)');
    if (startupError) fail('存在启动错误时不可判定为 PASSED');
    if (hasFail || hasNotVerified || hasBlocked) fail('存在失败、未验证或受阻需求时不可判定为 PASSED');
  } else if (check.outcome === 'FUNCTIONAL_FAILED') {
    if (!hasFail && !startupError) fail('未观察到功能失败或启动错误时不可判定为 FUNCTIONAL_FAILED');
  }
  return true;
}

export function validateTaskObject(task, expectedId, stateRoot) {
  plain(task, 'task');
  for (const k of Object.keys(task)) if (!TASK_KEYS.has(k)) fail(`task 含未知字段：${k}`);
  required(task, [...TASK_KEYS].filter(k => !['error', 'blockedReason', 'startupCheck', 'startupHistory', 'functionalCheck', 'functionalHistory', 'deliveryChecklist', 'deliveryRevision', 'deliveryHistory', 'acceptanceHistory', 'unblockHistory'].includes(k)), 'task');
  if (![4, 5].includes(task.schemaVersion)) fail('任务 schemaVersion 必须为 4 或 5；旧任务需人工迁移，拒绝静默升级');
  if (typeof expectedId !== 'string' || !UUID.test(expectedId) || task.id !== expectedId) fail('任务记录 ID 与文件 ID 不匹配');
  if (!VALID_STATUSES.has(task.status)) fail('task.status 非法');
  if (typeof task.baseCommit !== 'string' || !COMMIT.test(task.baseCommit)) fail('baseCommit 必须为有效 Git 提交对象 ID');
  date(task.createdAt, 'createdAt'); date(task.updatedAt, 'updatedAt');
  for (const k of ['attempts', 'repairRounds', 'consecutiveFailures']) integer(task[k], k);
  if (![null, 'WORKER', 'REVIEWER'].includes(task.failurePhase) || typeof task.repairIntent !== 'boolean') fail('失败阶段或返工意图非法');
  validatePlan(task.plan);
  if (task.schemaVersion === 4 && task.repairRounds > task.plan.maxRepairRounds) fail('持久化返工次数已超出授权上限');
  if (task.schemaVersion === 5 && task.plan.reviewMode !== 'CODEX_DELIVERY_CHECK' && task.repairRounds > task.plan.maxRepairRounds) fail('持久化返工次数已超出授权上限');
  if (task.repairRounds > task.attempts) fail('返工次数不能超过编码执行次数');
  conversation(task.conversationId, 'conversationId');
  if (task.snapshotHash !== null && (typeof task.snapshotHash !== 'string' || !HASH.test(task.snapshotHash))) fail('snapshotHash 非法');
  if (task.worktreePath !== null) {
    text(task.worktreePath, 'worktreePath', { max: 4096 });
    const { workspacesDir } = getStoragePaths(stateRoot);
    if (task.worktreePath !== path.join(workspacesDir, task.id)) fail('worktreePath 不是本任务的规范隔离路径');
  }
  // Every active phase has explicit owner and spawn state; absent fields are never treated as dead.
  if (task.owner !== null) validateOwner(task.owner);
  if (task.activeChild !== null) validateChild(task.activeChild);
  if (['RUNNING', 'REVIEWING'].includes(task.status)) {
    if (!task.owner || !task.activeChild || !task.worktreePath) fail('活跃任务缺少 owner、child 或工作树元数据');
    const allowedTypes = task.status === 'RUNNING' ? ['worker'] : ['reviewer', 'manual'];
    if (!allowedTypes.includes(task.activeChild.type) || task.owner.host !== task.activeChild.host) fail('活跃任务阶段与进程类型不匹配');
    if (task.status === 'RUNNING' && task.activeChild.status === 'NOT_STARTED') fail('编码阶段不允许 manual NOT_STARTED');
  } else {
    if (task.status !== 'BLOCKED' && (task.owner !== null || task.activeChild !== null)) fail('非活跃任务残留未关闭的进程元数据');
    if (task.status === 'BLOCKED' && task.owner !== null && task.activeChild === null) fail('BLOCKED owner 缺少对应 child');
  }
  if (['AWAITING_CODEX_REVIEW', 'REVIEWING', 'PASSED'].includes(task.status) && (!task.worktreePath || !task.snapshotHash)) fail('代码审查状态缺少工作树或有效快照');
  if (['AWAITING_FUNCTIONAL_CHECK', 'AWAITING_LAUNCH_CHECK', 'READY_FOR_USER_TEST'].includes(task.status) && (!task.worktreePath || !task.workerResult || task.attempts < 1)) fail('启动或功能检查状态缺少编码结果或工作树');
  if (task.status === 'FAILED' && (!task.failurePhase || task.consecutiveFailures === 0)) fail('FAILED 缺少失败阶段或次数');
  validateFindings(task.findings);
  if (task.review !== null) validateReview(task.review, task);
  if (!Array.isArray(task.reviewHistory) || !Array.isArray(task.executionHistory)) fail('历史记录必须为数组');
  for (const item of task.reviewHistory) validateReview(item, task, true);
  for (const item of task.executionHistory) validateExecution(item);
  if (task.workerResult !== null) validateWorkerResult(task.workerResult);
  if (task.status === 'PASSED' && (!task.review || task.review.decision !== 'PASS' || task.review.snapshotHash !== task.snapshotHash || task.repairIntent)) fail('PASSED 缺少一致的通过审查记录');
  if (task.startupCheck !== undefined && task.startupCheck !== null) validateStartupCheck(task.startupCheck, task);
  if (task.startupHistory !== undefined) {
    if (!Array.isArray(task.startupHistory)) fail('startupHistory 必须为数组');
    for (const item of task.startupHistory) validateStartupCheck(item, task, true);
  }
  if (task.functionalCheck !== undefined && task.functionalCheck !== null) validateFunctionalCheck(task.functionalCheck, task);
  if (task.functionalHistory !== undefined) {
    if (!Array.isArray(task.functionalHistory)) fail('functionalHistory 必须为数组');
    for (const item of task.functionalHistory) validateFunctionalCheck(item, task, true);
  }
  if (task.status === 'READY_FOR_USER_TEST') {
    if (task.plan.reviewMode === 'CODEX_FUNCTIONAL_CHECK') {
      if (!task.functionalCheck || task.functionalCheck.outcome !== 'PASSED' || task.functionalCheck.workerAttempt !== task.attempts || task.repairIntent) {
        fail('缺少当前轮真实功能确认通过记录');
      }
    } else {
      if (task.startupCheck?.outcome !== 'OPENED' || task.startupCheck.workerAttempt !== task.attempts || task.repairIntent) {
        fail('缺少当前轮真实打开记录');
      }
    }
  }
  if (task.status === 'AWAITING_USER_ACCEPTANCE') {
    if (!task.deliveryChecklist || !task.deliveryChecklist.some(i => i.status === 'READY_FOR_ACCEPTANCE')) {
      fail('AWAITING_USER_ACCEPTANCE 必须包含等待用户验收的需求项');
    }
  }
  if (task.status === 'ACCEPTED') {
    if (!task.deliveryChecklist || task.deliveryChecklist.length === 0 || !task.deliveryChecklist.every(i => i.status === 'ACCEPTED')) {
      fail('ACCEPTED 状态必须所有需求项均被用户显式验收');
    }
  }
  if (task.status === 'CHANGES_REQUESTED') {
    if (!task.repairIntent) fail('CHANGES_REQUESTED 必须有 repairIntent');
    const isDeliveryFeedback = task.deliveryChecklist && task.deliveryChecklist.some(it => ['REJECTED', 'PARTIAL', 'TODO'].includes(it.status));
    const validFeedback = (task.review?.decision === 'CHANGES_REQUESTED') ||
      (task.startupCheck?.outcome === 'STARTUP_FAILED' && task.startupCheck.workerAttempt === task.attempts) ||
      (task.functionalCheck?.outcome === 'FUNCTIONAL_FAILED' && task.functionalCheck.workerAttempt === task.attempts) ||
      (task.workerResult?.deliveryValidation && !task.workerResult.deliveryValidation.allImplemented) ||
      isDeliveryFeedback;
    if (!validFeedback) fail('CHANGES_REQUESTED 缺少有效的返工依据（清单未完成/启动失败/功能失败/显式代码审查/用户驳回）');
  }
  if (task.deliveryChecklist !== undefined && task.deliveryChecklist !== null) {
    if (!Array.isArray(task.deliveryChecklist)) fail('deliveryChecklist 必须为数组');
  }
  if (task.deliveryRevision !== undefined && task.deliveryRevision !== null) {
    integer(task.deliveryRevision, 'deliveryRevision');
  }
  if (task.deliveryHistory !== undefined && task.deliveryHistory !== null) {
    if (!Array.isArray(task.deliveryHistory)) fail('deliveryHistory 必须为数组');
  }
  if (task.acceptanceHistory !== undefined && task.acceptanceHistory !== null) {
    if (!Array.isArray(task.acceptanceHistory)) fail('acceptanceHistory 必须为数组');
  }
  if (task.unblockHistory !== undefined && task.unblockHistory !== null) {
    if (!Array.isArray(task.unblockHistory)) fail('unblockHistory 必须为数组');
  }
  for (const k of ['error', 'blockedReason']) if (task[k] !== undefined && task[k] !== null) text(task[k], k);
  return true;
}
export function saveTask(task, explicitRoot) {
  validateTaskObject(task, task?.id, explicitRoot);
  initStorage(explicitRoot);
  const { stateDir } = getStoragePaths(explicitRoot);
  const dst = taskPath(task.id, stateDir, 'json');
  if (fs.existsSync(dst) && !fs.lstatSync(dst).isFile()) fail('目标任务记录不是普通文件');
  const tmp = taskPath(task.id, stateDir, `tmp-${randomUUID()}`);
  const payload = JSON.stringify({ ...task, updatedAt: new Date().toISOString() }, null, 2) + '\n';
  if (Buffer.byteLength(payload) > 16 * 1024 * 1024) fail('任务历史超过 16MB 状态上限，拒绝写入不可再次读取的记录');
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, dst);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function loadTask(id, explicitRoot) {
  const { stateDir } = getStoragePaths(explicitRoot);
  const task = readPrivateJson(taskPath(id, stateDir, 'json'));
  validateTaskObject(task, id, explicitRoot);
  return task;
}
export function listTasks(explicitRoot) {
  const { stateDir } = getStoragePaths(explicitRoot);
  if (!fs.existsSync(stateDir)) return [];
  const result = [];
  for (const file of fs.readdirSync(stateDir)) {
    if (!file.endsWith('.json')) continue;
    const id = file.slice(0, -5);
    if (!UUID.test(id)) { result.push({ corrupted: true, id, error: '任务文件名不是有效 UUID' }); continue; }
    try { result.push({ corrupted: false, task: loadTask(id, explicitRoot) }); }
    catch (err) { result.push({ corrupted: true, id, error: err.message }); }
  }
  return result.sort((a, b) => (Date.parse(b.task?.updatedAt || '') || 0) - (Date.parse(a.task?.updatedAt || '') || 0));
}
function childLiveness(child) {
  if (child === null || child.status === 'NOT_STARTED') return 'CLOSED';
  if (child.status === 'SPAWNING') return 'UNKNOWN';
  const leader = checkProcessLiveness(child.pid, child.host);
  const group = processGroupLiveness(child.pgid, child.host);
  if (leader === 'ALIVE' || group === 'ALIVE') return 'ALIVE';
  if (leader === 'UNKNOWN' || group === 'UNKNOWN') return 'UNKNOWN';
  return 'DEAD';
}
export function recoverTask(taskId, reason, explicitRoot) {
  text(reason, '恢复原因', { max: 10000 });
  return withMutationGate(taskId, explicitRoot, () => {
    const { stateDir } = getStoragePaths(explicitRoot);
    const lockFile = taskPath(taskId, stateDir, 'lock');
    const task = loadTask(taskId, explicitRoot);
    let lockLiveness = 'CLOSED';
    if (fs.existsSync(lockFile)) {
      const lock = readPrivateJson(lockFile); validateLock(lock);
      lockLiveness = checkProcessLiveness(lock.pid, lock.host);
    }
    const ownerLiveness = task.owner === null ? 'CLOSED' : checkProcessLiveness(task.owner.pid, task.owner.host);
    const childState = childLiveness(task.activeChild);
    if ([lockLiveness, ownerLiveness, childState].some(s => s === 'ALIVE' || s === 'UNKNOWN')) fail(`拒绝恢复：仍有活跃或无法确认的进程（锁 ${lockLiveness}，owner ${ownerLiveness}，child/group ${childState}）`);
    const active = task.status === 'RUNNING' || task.status === 'REVIEWING';
    const updated = { ...task, status: active ? 'BLOCKED' : task.status, owner: null, activeChild: null,
      error: `显式恢复：${reason.trim()}`,
      ...(active ? { blockedReason: '原任务中断，确认全部关联进程退出后停止；隔离工作树已保留' } : {}) };
    // Persist the safe state before removing the canonical lock. A failed save keeps the lock.
    saveTask(updated, explicitRoot);
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    return updated;
  });
}

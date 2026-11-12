#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MODULES = ['router', 'scheduler', 'context-manager', 'worker-manager', 'watchdog', 'task-store'];
const SPEC = {
  help: [],
  doctor: ['state-root', 'repo', 'agy', 'codex', 'probe-write'],
  plan: ['state-root', 'repo', 'goal', 'scope', 'file', 'workorder', 'max-repair-rounds', 'max-consecutive-failures', 'max-no-progress-rounds', 'review-mode', 'task-kind', 'agy-permission-policy'],
  run: ['state-root', 'id', 'agy', 'timeout-ms'],
  inspect: ['state-root', 'id', 'code-review', 'delivery'],
  acceptance: ['state-root', 'id', 'file'],
  unblock: ['state-root', 'id', 'requirement-id', 'reason'],
  report: ['state-root', 'id', 'format', 'file'],
  confirm: ['state-root', 'id', 'file'],
  verify: ['state-root', 'id', 'file', 'kind', 'target', 'result', 'error', 'evidence'],
  review: ['state-root', 'id', 'file', 'decision', 'reason'],
  'review-agent': ['state-root', 'id', 'codex', 'timeout-ms'],
  auto: ['state-root', 'id', 'agy', 'worker-timeout-ms'],
  recover: ['state-root', 'id', 'reason'],
  status: ['state-root', 'id'],
  list: ['state-root']
};
const HELP = `SuperAgent v0.7.0 (Protocol 4.0) — 规划 → 编码/自检 → 交付清单核对 → 用户手动验收
  doctor [--repo DIR] [--agy FILE] [--probe-write]
  plan --repo DIR --goal "需求" --scope "src/**" [--scope "docs/**"]
  plan --file workorder.json
    [--task-kind DEVELOPMENT|RELEASE] [--agy-permission-policy AUTO_APPROVE|STANDARD]
  auto --id UUID [--agy FILE] [--worker-timeout-ms 600000]
  run --id UUID [--agy FILE] [--timeout-ms 600000]
  inspect --id UUID [--delivery]
  acceptance --id UUID --file user-feedback.json
  unblock --id UUID --requirement-id REQ-ID --reason TEXT
  report --id UUID [--format json|markdown] [--file FILE]
  status --id UUID
  recover --id UUID --reason "已核实进程退出"
  list
旧模式兼容（仅旧任务或显式指定时）：
  confirm --id UUID --file functional-check.json
  verify --id UUID --kind web --target http://localhost:5173 --result opened --evidence "实际打开观察"
  inspect --id UUID --code-review
  review-agent --id UUID [--codex FILE] [--timeout-ms 300000]
  review --id UUID --file code-review.json
通用：--state-root DIR 或 SUPER_AGENT_HOME；默认 ~/.codex/super-agent。
auto 自动调度编码及清单补齐；默认由 Worker 按需自检并生成交付清单，经完整性核对后交用户手动验收。
Agent 自检不代表用户验收通过；仅用户显式反馈方可将状态置为 ACCEPTED 或 REJECTED。
发布（含 GitHub/Gitee、新版本及发布准备）仅由 Codex 模型执行；run/auto 返回 CODEX_ONLY 交接，不调用 agy。
常规开发的 agy 默认 AUTO_APPROVE：在隔离工作树内启用会话工具自动批准和终端隔离，不覆盖平台强制拒绝；STANDARD 可收紧。
`;
let api = {};
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function parseArgs() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return {cmd: 'help', opts: {}};
  const cmd = argv.shift() || 'help';
  if (!Object.hasOwn(SPEC, cmd)) throw new Error(`未知命令：${cmd}`);
  const opts = Object.create(null);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--') || !SPEC[cmd].includes(token.slice(2))) throw new Error(`未知参数：${token}`);
    const key = token.slice(2);
    if (!['scope', 'error', 'requirement-id'].includes(key) && Object.hasOwn(opts, key)) throw new Error(`参数不可重复：--${key}`);
    if (['probe-write', 'code-review', 'delivery'].includes(key)) { opts[key] = true; continue; }
    const value = argv[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`--${key} 必须提供非空值`);
    if (['scope', 'error', 'requirement-id'].includes(key)) (opts[key] ||= []).push(value);
    else opts[key] = value;
  }
  return {cmd, opts};
}
function required(opts, key) {
  if (!opts[key]) throw new Error(`缺少 --${key}`);
  return opts[key];
}
function timeoutOption(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error('超时必须为整数毫秒');
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 3600000) throw new Error('超时必须在 1000~3600000 毫秒之间');
  return ms;
}
function countOption(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error('次数必须为非负整数');
  return Number(value);
}
async function loadModules(tolerateFailure = false, includeCodeReview = false) {
  const statuses = {};
  for (const name of [...MODULES, ...(includeCodeReview ? ['worker-manager/codex-reviewer'] : [])]) {
    const relative = name.includes('/') ? `./${name}.mjs` : `./${name}/index.mjs`;
    try { Object.assign(api, await import(relative)); statuses[name] = 'OK'; }
    catch (err) {
      statuses[name] = `导入失败：${err.message}`;
      if (!tolerateFailure) throw new Error(`${name} 无法加载：${err.message}`);
    }
  }
  return statuses;
}
function git(cwd, args) {
  const env={...process.env};
  for(const key of Object.keys(env)) if(key.startsWith('GIT_')) delete env[key];
  return execFileSync('git', ['--no-optional-locks', '-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', ...args],
    {env,encoding:'utf8', timeout:30000, maxBuffer:8*1024*1024, stdio:['ignore','pipe','pipe']}).trim();
}
function repository(input) {
  const real = fs.realpathSync(input);
  if (!fs.statSync(real).isDirectory() || fs.realpathSync(git(real, ['rev-parse','--show-toplevel'])) !== real) throw new Error('请指定 Git 仓库根目录');
  return real;
}
function block(task, root, reason, patch = {}) {
  const result = task.status === 'BLOCKED' ? {...task, ...patch} : api.transition(task, 'BLOCKED', patch);
  Object.assign(result, {blockedReason:reason, error:reason, owner:null});
  if (!patch.activeChild) result.activeChild = null;
  api.saveTask(result, root);
  return result;
}
function snapshot(task, root) {
  if (!task.worktreePath || !task.snapshotHash) throw new Error('缺少工作树或已记录快照');
  const state = api.inspectWorktreeState(task.worktreePath, task.plan.repo, task.baseCommit, task.plan.scope, root, task.id);
  if (state.snapshotHash !== task.snapshotHash) throw new Error('工作树内容与已记录快照不一致，旧审查结论失效');
  if (state.hasViolations || state.hasScopeViolations) throw new Error('工作树存在范围或敏感路径违规');
  return state;
}
function ensureWorktree(task, root) {
  const {workspacesDir} = api.getStoragePaths(root);
  api.initStorage(root);
  if (!task.worktreePath) {
    const target = path.join(workspacesDir, task.id);
    if (fs.existsSync(target)) throw new Error('隔离目录已存在，拒绝覆盖');
    task.worktreePath = target;
    // Preserve the intended location even if Git creates only part of the new worktree.
    api.saveTask(task, root);
    const repo=repository(task.plan.repo);
    let filterKeys;
    try { filterKeys=git(repo,['config','--name-only','--get-regexp','^filter\\..*\\.(smudge|process)$']); }
    catch(err) { if(err.status===1) filterKeys=''; else throw err; }
    const checkoutOptions=[];
    for(const key of filterKeys.split('\n').filter(Boolean)) {
      if(!/^filter\.[A-Za-z0-9_.-]+\.(smudge|process)$/.test(key)) throw new Error('无法安全禁用仓库检出过滤器');
      const prefix=key.replace(/\.(smudge|process)$/,'');
      checkoutOptions.push('-c',`${prefix}.smudge=`,'-c',`${prefix}.process=`,'-c',`${prefix}.required=false`);
    }
    git(repo, [...checkoutOptions,'worktree','add','--detach',target,task.baseCommit]);
  }
  api.verifyWorktreeIntegrity(task.worktreePath, task.plan.repo, task.baseCommit, root, task.id);
  // Preflight rejects hidden index states and out-of-scope changes before giving a Worker control.
  const inspect = task.plan.reviewMode === 'CODEX_STARTUP_CHECK' ? api.inspectStartupChanges : api.inspectWorktreeState;
  const state = inspect(task.worktreePath, task.plan.repo, task.baseCommit, task.plan.scope, root, task.id);
  if (state.hasViolations || state.hasScopeViolations) throw new Error('现有工作树范围或路径检查失败');
  return task.worktreePath;
}
function limits(task, root, phase) {
  if (task.consecutiveFailures >= task.plan.maxConsecutiveFailures) {
    block(task, root, '连续失败已达到上限，停止执行');
    throw new Error('连续失败预算耗尽，任务已标记 BLOCKED');
  }
  if (phase === 'WORKER' && (task.repairIntent || task.status === 'CHANGES_REQUESTED')) {
    if (task.plan.reviewMode !== 'CODEX_DELIVERY_CHECK') {
      if (task.repairRounds >= task.plan.maxRepairRounds) {
        block(task, root, '返工轮次已达到上限，停止执行');
        throw new Error('返工预算耗尽，任务已标记 BLOCKED');
      }
    }
  }
}
function childRecord(type, pid, pgid) {
  return {status:'RUNNING', pid, pgid, host:os.hostname(), type, startedAt:new Date().toISOString()};
}
function activePatch(type) {
  const now = new Date().toISOString();
  return {
    owner:{pid:process.pid, host:os.hostname(), startedAt:now},
    activeChild:{status:'SPAWNING', host:os.hostname(), type, startedAt:now}
  };
}
function handleFailure(id, root, phase, err, started) {
  const task = api.loadTask(id, root);
  if (task.status === 'BLOCKED') return task;
  const failures = task.consecutiveFailures + 1;
  const record = {attempt:task.attempts,type:phase, status:'FAILED', error:String(err.message).slice(0,2000), code:err.code || 'ERR_EXECUTION',
    durationMs:Date.now()-started, recordedAt:new Date().toISOString(), usage:err.usage ?? null};
  const uncertain = err.processGroupUnconfirmed === true;
  const tracked = uncertain ? (task.activeChild?.status === 'RUNNING' ? task.activeChild :
    childRecord(phase === 'WORKER' ? 'worker' : 'reviewer', err.childPid, err.pgid)) : null;
  const fatal = uncertain || err.isCancelled || err.isSystemFailure || ['EACCES','EPERM','ERR_SNAPSHOT_MISMATCH'].includes(err.code);
  const next = fatal || failures >= task.plan.maxConsecutiveFailures ? 'BLOCKED' : 'FAILED';
  const updated = api.transition(task, next, {
    failurePhase:phase, consecutiveFailures:failures, error:record.error,
    blockedReason:next === 'BLOCKED' ? `${phase} 已停止：${record.error}` : null,
    owner:null, activeChild:tracked,
    executionHistory:[...task.executionHistory, record],
    reviewHistory:phase === 'REVIEWER' ? [...task.reviewHistory, {
      decision:'FAILED',error:record.error,usage:record.usage,durationMs:record.durationMs,
      reviewedAt:record.recordedAt,reviewerType:'CODEX_INDEPENDENT_AGENT'
    }] : task.reviewHistory
  });
  api.saveTask(updated, root);
  return updated;
}
function recordFailureAndThrow(id, root, phase, err, started) {
  try { handleFailure(id,root,phase,err,started); }
  catch (recordError) {
    // A storage failure must not discard the reason the task lock needs to survive.
    if (err.processGroupUnconfirmed) Object.assign(recordError, {
      processGroupUnconfirmed:true, childPid:err.childPid, pgid:err.pgid
    });
    throw recordError;
  }
  throw err;
}
async function workerStep(id, root, executable, timeoutMs) {
  let task = api.loadTask(id, root);
  api.assertAntigravityTask(task.plan);
  if (!api.canRunWorker(task)) throw new Error(`当前状态不能编码：${task.status}/${task.failurePhase}`);
  limits(task, root, 'WORKER');
  const repair = task.repairIntent || task.status === 'CHANGES_REQUESTED';
  if (repair && !task.conversationId) { block(task,root,'返工缺少有效原会话 ID'); throw new Error('返工缺少原会话 ID'); }
  try { ensureWorktree(task, root); }
  catch (err) { block(task,root,`工作树预检查失败：${err.message}`); throw err; }
  task = api.transition(task, 'RUNNING', {...activePatch('worker'), attempts:task.attempts+1,
    repairIntent:repair, repairRounds:task.repairRounds+(repair ? 1 : 0), failurePhase:null, startupCheck:null, functionalCheck:null});
  api.saveTask(task,root);
  const started = Date.now();
  try {
    const result = await api.runAntigravity({
      executable,
      cwd: task.worktreePath,
      prompt: api.workerPrompt(task),
      conversationId: task.conversationId,
      timeoutMs,
      acceptance: task.plan.acceptance,
      reviewMode: task.plan.reviewMode,
      currentChecklist: task.deliveryChecklist,
      currentRevision: task.deliveryRevision,
      workOrder: task.plan,
      agyPermissionPolicy: api.normalizeAgyPermissionPolicy(task.plan.agyPermissionPolicy),
      onChildSpawned: (pid, pgid) => {
        task.activeChild = childRecord('worker', pid, pgid);
        api.saveTask(task, root);
      }
    });
    if (task.conversationId && result.conversationId !== task.conversationId) {
      const err=new Error('Worker 续会话 ID 与任务不一致'); err.isSystemFailure=true; throw err;
    }
    let state;
    try {
      const inspect = ['CODEX_DELIVERY_CHECK', 'CODEX_FUNCTIONAL_CHECK', 'CODEX_STARTUP_CHECK'].includes(task.plan.reviewMode) ? api.inspectStartupChanges : api.inspectWorktreeState;
      state=inspect(task.worktreePath,task.plan.repo,task.baseCommit,task.plan.scope,root,task.id);
      if (state.hasViolations || state.hasScopeViolations) throw new Error('Worker 改动超出范围或触碰敏感路径');
    } catch(err) { err.isSystemFailure=true; throw err; }

    const isDeliveryMode = task.plan.reviewMode === 'CODEX_DELIVERY_CHECK';
    const isFunctionalMode = task.plan.reviewMode === 'CODEX_FUNCTIONAL_CHECK';
    const validation = result.deliveryValidation;
    let nextStatus;
    let blockedReason = null;
    let error = null;
    let repairIntent = false;
    let findings = [];

    if (isDeliveryMode) {
      if (!result.deliveryReport || !validation?.valid) {
        nextStatus = 'CHANGES_REQUESTED';
        repairIntent = true;
        const issuesList = validation?.issues || ['交付清单未通过完整性核对'];
        findings = issuesList.map(issue => `【清单待补齐】${issue}`);
        error = `交付清单未通过完整性核对：${issuesList.join('; ')}`;
      } else {
        try {
          const mergeResult = api.mergeDeliveryReport({
            currentChecklist: task.deliveryChecklist,
            currentRevision: task.deliveryRevision,
            workerEnvelope: result.deliveryReport,
            workerAttempt: task.attempts,
            maxNoProgressRounds: task.plan.maxNoProgressRounds ?? 2
          });
          task.deliveryChecklist = mergeResult.updatedChecklist;
          task.deliveryRevision = mergeResult.newRevision;
          task.deliveryHistory = [...(task.deliveryHistory || []), mergeResult.deliveryHistoryEntry];

          if (mergeResult.allAccepted) {
            nextStatus = 'ACCEPTED';
            repairIntent = false;
          } else if (mergeResult.hasActionable) {
            nextStatus = 'CHANGES_REQUESTED';
            repairIntent = true;
          } else if (mergeResult.statusCounts.READY_FOR_ACCEPTANCE > 0) {
            nextStatus = 'AWAITING_USER_ACCEPTANCE';
            repairIntent = false;
          } else if (mergeResult.statusCounts.BLOCKED > 0) {
            nextStatus = 'BLOCKED';
            blockedReason = '所有未完成需求均处于受阻状态，等待解除或用户介入';
            error = blockedReason;
            repairIntent = false;
          } else {
            nextStatus = 'AWAITING_USER_ACCEPTANCE';
            repairIntent = false;
          }
        } catch (mergeErr) {
          nextStatus = 'CHANGES_REQUESTED';
          repairIntent = true;
          findings = [`【交付合并错误】${mergeErr.message}`];
          error = mergeErr.message;
        }
      }
    } else if (isFunctionalMode && validation) {
      if (validation.hasBlocked) {
        nextStatus = 'BLOCKED';
        const reasons = validation.blockedItems.map(b => `${b.requirementId}: ${b.reason || '阻塞'} (待处理条件: ${b.unblockConditions || '无'})`).join('; ');
        blockedReason = `Worker 报告需求受阻停止：${reasons}`;
        error = blockedReason;
      } else if (!validation.allImplemented) {
        const exhausted = task.repairRounds >= task.plan.maxRepairRounds;
        if (exhausted) {
          nextStatus = 'BLOCKED';
          blockedReason = `交付清单未完成/缺项，且返工轮次已达上限 (${task.plan.maxRepairRounds} 轮)`;
          error = blockedReason;
        } else {
          nextStatus = 'CHANGES_REQUESTED';
          repairIntent = true;
          findings = validation.issues.map(issue => `【清单待补齐】${issue}`);
          error = `交付清单未完全实现：${validation.issues.join('; ')}`;
        }
      } else {
        nextStatus = 'AWAITING_FUNCTIONAL_CHECK';
      }
    } else {
      nextStatus = task.plan.reviewMode === 'CODEX_STARTUP_CHECK' ? 'AWAITING_LAUNCH_CHECK' : 'AWAITING_CODEX_REVIEW';
    }

    const record={type:'WORKER',status:'SUCCESS',attempt:task.attempts,usage:result.usage ?? null,
      durationMs:Date.now()-started,recordedAt:new Date().toISOString()};
    task=api.transition(task, nextStatus, {
      workerResult: result,
      conversationId: result.conversationId,
      snapshotHash: state.snapshotHash,
      failurePhase: null,
      owner: null,
      activeChild: null,
      consecutiveFailures: 0,
      error,
      blockedReason,
      repairIntent,
      findings,
      executionHistory: [...task.executionHistory, record]
    });
    api.saveTask(task,root); return task;
  } catch(err) { recordFailureAndThrow(id,root,'WORKER',err,started); }
}
function packetFor(task,root) {
  // Only explicitly requested code-review commands enter this path.
  if (!task.snapshotHash) {
    const state=api.inspectWorktreeState(task.worktreePath,task.plan.repo,task.baseCommit,task.plan.scope,root,task.id);
    task.snapshotHash=state.snapshotHash; api.saveTask(task,root);
  }
  snapshot(task,root);
  const packet=api.reviewPacket(task,root);
  if (packet.snapshotHash !== task.snapshotHash) throw new Error('审查材料与任务快照不一致');
  return packet;
}
function commitReview(task,root,result,hash,usage,reviewerType,started) {
  const now=new Date().toISOString();
  const record={...result,snapshotHash:hash,usage:usage ?? null,reviewedAt:now,reviewerType,durationMs:Date.now()-started};
  const requested=result.decision==='CHANGES_REQUESTED';
  const exhausted=requested && task.repairRounds>=task.plan.maxRepairRounds;
  const status=result.decision==='PASS' ? 'PASSED' : requested && !exhausted ? 'CHANGES_REQUESTED' : 'BLOCKED';
  task=api.transition(task,status,{review:record,reviewHistory:[...task.reviewHistory,record],
    executionHistory:[...task.executionHistory,{attempt:task.attempts,type:'REVIEWER',status:'SUCCESS',usage:usage ?? null,
      durationMs:record.durationMs,recordedAt:now}],findings:result.findings,
    repairIntent:requested && !exhausted,failurePhase:null,owner:null,activeChild:null,consecutiveFailures:0,error:null,
    blockedReason:status==='BLOCKED' ? (exhausted ? '返工轮次已达上限' : result.summary) : null});
  api.saveTask(task,root); return task;
}
async function reviewStep(id,root,executable,timeoutMs) {
  let task=api.loadTask(id,root);
  if (!api.canReview(task)) throw new Error(`当前状态不能审查：${task.status}/${task.failurePhase}`);
  limits(task,root,'REVIEWER');
  let packet;
  try { packet=packetFor(task,root); }
  catch(err) { block(task,root,`审查材料无效：${err.message}`); throw err; }
  task=api.transition(task,'REVIEWING',{...activePatch('reviewer'),failurePhase:null}); api.saveTask(task,root);
  const started=Date.now();
  try {
    const result=await api.runCodexReviewer({executable,task,reviewPacket:packet,stateRoot:root,timeoutMs,
      onChildSpawned:(pid,pgid)=>{task.activeChild=childRecord('reviewer',pid,pgid);api.saveTask(task,root);}});
    snapshot(task,root);
    return commitReview(task,root,result.reviewResult,result.snapshotHash,result.usage,'CODEX_INDEPENDENT_AGENT',started);
  } catch(err) { err.isSystemFailure=true; recordFailureAndThrow(id,root,'REVIEWER',err,started); }
}
function effectiveStatus(task,root) {
  if (task.status!=='PASSED') return {effectiveStatus:task.status,snapshotValid:null};
  try { snapshot(task,root); return {effectiveStatus:'PASSED',snapshotValid:true}; }
  catch(err) { return {effectiveStatus:'STALE_INVALIDATED',snapshotValid:false,invalidReason:err.message}; }
}
function taskSummary(task, root) {
  const isDelivery = task.plan.reviewMode === 'CODEX_DELIVERY_CHECK';
  const isFunc = task.plan.reviewMode === 'CODEX_FUNCTIONAL_CHECK';
  const openingOk = isFunc
    ? (task.status === 'READY_FOR_USER_TEST' && task.functionalCheck?.outcome === 'PASSED' && task.functionalCheck.workerAttempt === task.attempts)
    : (task.status === 'READY_FOR_USER_TEST' && task.startupCheck?.outcome === 'OPENED' && task.startupCheck.workerAttempt === task.attempts);

  const deliveryCounts = (isDelivery && task.deliveryChecklist) ? api.computeStatusCounts(task.deliveryChecklist) : null;
  const deliveryStatus = isDelivery ? (
    task.status === 'ACCEPTED' ? 'ALL_ACCEPTED' :
    task.status === 'AWAITING_USER_ACCEPTANCE' ? 'AWAITING_USER_ACCEPTANCE' :
    task.status === 'BLOCKED' ? 'HAS_BLOCKED' :
    (task.deliveryChecklist?.some(i => i.status === 'READY_FOR_ACCEPTANCE') ? 'PARTIAL_READY' : 'IN_PROGRESS')
  ) : (task.workerResult?.deliveryValidation?.allImplemented ? 'ALL_IMPLEMENTED' : task.workerResult?.deliveryValidation?.hasBlocked ? 'HAS_BLOCKED' : task.workerResult ? 'INCOMPLETE' : null);

  const manualTesting = isDelivery
    ? (task.status === 'AWAITING_USER_ACCEPTANCE' ? 'WAITING_FOR_USER' : (task.status === 'ACCEPTED' ? 'USER_ACCEPTED' : 'NOT_HANDED_OFF'))
    : (task.status === 'READY_FOR_USER_TEST' ? 'WAITING_FOR_USER' : 'NOT_HANDED_OFF');

  return {
    id: task.id,
    taskKind: task.plan.taskKind ?? 'DEVELOPMENT',
    executionPolicy: api.resolveExecutionPolicy(task.plan),
    agyPermissionPolicy: api.normalizeAgyPermissionPolicy(task.plan.agyPermissionPolicy),
    recordedStatus: task.status,
    ...effectiveStatus(task, root),
    attempts: task.attempts,
    repairRounds: task.repairRounds,
    consecutiveFailures: task.consecutiveFailures,
    failurePhase: task.failurePhase,
    worktreePath: task.worktreePath,
    snapshotHash: task.snapshotHash,
    blockedReason: task.blockedReason ?? null,
    error: task.error ?? null,
    verificationScope: isDelivery ? 'DELIVERY_CHECKLIST' : (task.functionalCheck ? 'FUNCTIONAL_CHECK' : task.startupCheck ? 'STARTUP_ONLY' : task.review ? 'EXPLICIT_CODE_REVIEW' : 'NOT_VERIFIED'),
    deliveryRevision: task.deliveryRevision ?? null,
    deliveryStatus,
    deliveryStatusCounts: deliveryCounts,
    deliveryChecklist: task.deliveryChecklist ?? null,
    deliveryHistory: task.deliveryHistory ?? [],
    acceptanceHistory: task.acceptanceHistory ?? [],
    unblockHistory: task.unblockHistory ?? [],
    deliveryReport: task.workerResult?.deliveryReport ?? null,
    functionalCheck: task.functionalCheck ?? null,
    functionalHistory: task.functionalHistory ?? [],
    startupCheck: task.startupCheck ?? null,
    startupHistory: task.startupHistory ?? [],
    openingVerified: openingOk,
    functionalVerified: task.status === 'READY_FOR_USER_TEST' && task.functionalCheck?.outcome === 'PASSED' && task.functionalCheck.workerAttempt === task.attempts,
    manualTesting,
    review: task.review,
    reviewHistory: task.reviewHistory,
    executionHistory: task.executionHistory
  };
}

function codexOnlyHandoff(task) {
  const policy = api.resolveExecutionPolicy(task.plan);
  if (policy.target !== 'CODEX_ONLY') return null;
  return {
    id: task.id,
    status: 'CODEX_ONLY',
    recordedStatus: task.status,
    target: 'CODEX',
    reason: policy.reason,
    nextAction: 'CURRENT_CODEX_EXECUTE_RELEASE',
    instruction: '由当前 Codex 模型处理发布及其版本、更新说明、打包、签名、公证、标签、上传与发布问题修复；混合任务先拆分。发布目标和内容须在用户授权范围内。此交接不代表已发布或已验收。',
    agyInvoked: false
  };
}

function functionalHandoff(task, root) {
  const summary = taskSummary(task, root);
  let nextAction = null;
  let instruction = '';

  if (task.plan.reviewMode === 'CODEX_DELIVERY_CHECK') {
    if (task.status === 'AWAITING_USER_ACCEPTANCE') {
      nextAction = 'USER_MANUAL_ACCEPTANCE';
      instruction = 'Worker 已自报交付清单且完整性核对通过。请用户根据手动测试步骤进行实际业务操作验证，并使用 acceptance 命令记录验收或驳回结论。';
    } else if (task.status === 'ACCEPTED') {
      nextAction = 'NONE_TASK_COMPLETED';
      instruction = '全部需求项已由用户显式手动验收通过，任务圆满完成。';
    } else if (task.status === 'BLOCKED') {
      nextAction = 'USER_INTERVENTION_REQUIRED';
      instruction = `任务已停止：${task.blockedReason || task.error || '遇到阻碍，请核查阻塞项并协助解除'}`;
    } else if (task.status === 'CHANGES_REQUESTED') {
      nextAction = 'RUN_AUTO_OR_WORKER_TO_REPAIR';
      instruction = '存在未完成项、被用户驳回项或清单待补齐项，需调用 Worker 续会话补齐修复。';
    } else if (task.status === 'RUNNING') {
      nextAction = 'WORKER_RUNNING';
      instruction = 'Worker 正在执行编码或自检。';
    } else {
      nextAction = 'PENDING';
      instruction = `当前任务状态：${task.status}`;
    }
  } else {
    if (task.status === 'AWAITING_FUNCTIONAL_CHECK') {
      nextAction = 'CURRENT_CODEX_CONFIRM_FUNCTIONAL';
      instruction = 'Worker 已自报交付清单。当前 Codex 核对清单、只读必要相关功能代码，并实际打开 App/网页进行逐项简短操作确认，之后用 confirm 命令记录。请勿全面审查代码或跑自动化测试。';
    } else if (task.status === 'AWAITING_LAUNCH_CHECK') {
      nextAction = 'CURRENT_CODEX_OPEN_APP_OR_WEB';
      instruction = '当前 Codex 继续实际启动 App 或打开测试网页，只观察能否正常打开及启动报错。打开后用 verify 记录，并保留窗口/服务交用户自行测试。';
    } else if (task.status === 'READY_FOR_USER_TEST') {
      nextAction = 'USER_MANUAL_TESTING';
      instruction = '已完成逐项功能确认与启动观察，窗口/服务保持可用，交由用户进行最终业务手工验收。';
    } else if (task.status === 'BLOCKED') {
      nextAction = 'USER_INTERVENTION_REQUIRED';
      instruction = `任务已停止：${task.blockedReason || task.error || '遇到阻碍'}`;
    } else if (task.status === 'CHANGES_REQUESTED') {
      nextAction = 'RUN_AUTO_OR_WORKER_TO_REPAIR';
      instruction = '存在未完成需求、启动错误或功能问题，需继续调用 Worker 返工修复。';
    }
  }

  const launch = task.workerResult?.deliveryReport?.launch;
  let launchInstructions = task.workerResult?.responseSummary ?? null;
  if (launch) {
    if (typeof launch === 'string') launchInstructions = launch;
    else if (typeof launch === 'object') launchInstructions = JSON.stringify(launch);
  }

  return {
    ...summary,
    nextAction,
    launchInstructions,
    instruction
  };
}

function startupHandoff(task, root) {
  return functionalHandoff(task, root);
}

function recordFunctionalCheck(id, root, opts) {
  let task = api.loadTask(id, root);
  if (!['AWAITING_FUNCTIONAL_CHECK', 'AWAITING_LAUNCH_CHECK', 'AWAITING_CODEX_REVIEW'].includes(task.status)) {
    throw new Error('仅在编码完成、等待功能确认时记录 confirm');
  }
  api.verifyWorktreeIntegrity(task.worktreePath, task.plan.repo, task.baseCommit, root, task.id);
  if (!opts.file) {
    throw new Error('confirm 命令要求提供完整的结构化功能确认报告文件：--file functional-check.json');
  }
  const file = path.resolve(opts.file);
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('功能确认记录超过 1MB');
  const check = JSON.parse(fs.readFileSync(file, 'utf8'));
  api.validateFunctionalCheck(check, task);
  const failed = check.outcome === 'FUNCTIONAL_FAILED';
  const blocked = ['NOT_VERIFIED', 'BLOCKED'].includes(check.outcome);
  const exhausted = failed && task.repairRounds >= task.plan.maxRepairRounds;

  let next;
  if (check.outcome === 'PASSED') {
    next = 'READY_FOR_USER_TEST';
  } else if (failed && !exhausted) {
    next = 'CHANGES_REQUESTED';
  } else {
    next = 'BLOCKED';
  }

  const reworkFindings = failed ? check.items.filter(it => it.result === 'FAIL').map(it => ({
    severity: 'HIGH',
    path: it.codeEvidence.split(':')[0] || 'unknown',
    location: it.codeEvidence.split(':')[1] || '1',
    problem: `需求 ${it.requirementId} 功能确认失败：操作 [${it.action}] 预期 [${it.expected}] 但实际观察到 [${it.observed}]`,
    impact: it.error || '功能未能按预期工作',
    requestedFix: `修复需求 ${it.requirementId} 的实现，满足预期表现`
  })) : [];

  task = api.transition(task, next, {
    functionalCheck: check,
    functionalHistory: [...(task.functionalHistory || []), check],
    findings: reworkFindings,
    repairIntent: failed && !exhausted,
    owner: null,
    activeChild: null,
    failurePhase: null,
    blockedReason: next === 'BLOCKED' ? (exhausted ? '功能返工次数已到上限' : check.summary) : null,
    error: failed ? check.items.filter(it => it.result === 'FAIL').map(it => `${it.requirementId}: ${it.error || it.observed}`).join('\n') : null
  });
  api.saveTask(task, root);
  return {
    ...taskSummary(task, root),
    message: next === 'READY_FOR_USER_TEST' ?
      '已逐项完成简短功能确认，启动正常；交付用户自行最终手工验收，不代表全面自动化测试或所有代码通过。' :
      failed ? '仅按实际功能确认失败项返工；由原 Worker 修复。' :
      '功能确认受阻或未完成验证，不能记录为通过。'
  };
}

function recordStartupCheck(id,root,opts) {
  let task=api.loadTask(id,root);
  if (task.plan.reviewMode === 'CODEX_FUNCTIONAL_CHECK') {
    throw new Error('当前任务采用逐项功能确认流程（CODEX_FUNCTIONAL_CHECK），拒绝 legacy verify；请使用 confirm 命令记录完整功能确认报告');
  }
  if (!['AWAITING_LAUNCH_CHECK','AWAITING_CODEX_REVIEW'].includes(task.status)) throw new Error('仅在编码完成、等待启动检查时记录verify');
  api.verifyWorktreeIntegrity(task.worktreePath,task.plan.repo,task.baseCommit,root,task.id);
  let check;
  if (opts.file) {
    if (['kind','target','result','error','evidence'].some(k=>Object.hasOwn(opts,k))) throw new Error('--file与启动观察参数不能混用');
    const file=path.resolve(opts.file);
    if (fs.statSync(file).size>256*1024) throw new Error('启动观察记录超过256KB');
    check=JSON.parse(fs.readFileSync(file,'utf8'));
  } else {
    const outcome={opened:'OPENED',failed:'STARTUP_FAILED',blocked:'NOT_VERIFIED'}[required(opts,'result')];
    if (!outcome) throw new Error('--result只接受opened/failed/blocked');
    check={taskId:task.id,workerAttempt:task.attempts,worktreePath:task.worktreePath,
      kind:opts.kind || 'unknown',target:opts.target ?? null,outcome,errors:opts.error || [],
      evidence:required(opts,'evidence'),observedAt:new Date().toISOString(),verificationScope:'STARTUP_ONLY',checkedBy:'CODEX_CURRENT_SESSION'};
  }
  api.validateStartupCheck(check,task);
  const failed=check.outcome==='STARTUP_FAILED';
  const exhausted=failed && task.repairRounds>=task.plan.maxRepairRounds;
  const next=check.outcome==='OPENED' ? 'READY_FOR_USER_TEST' : failed && !exhausted ? 'CHANGES_REQUESTED' : 'BLOCKED';
  task=api.transition(task,next,{startupCheck:check,
    startupHistory:[...(task.startupHistory || []),check],findings:[],repairIntent:failed && !exhausted,
    owner:null,activeChild:null,failurePhase:null,
    blockedReason:next==='BLOCKED' ? (exhausted ? '启动报错返工次数已到上限' : check.evidence) : null,
    error:failed ? check.errors.join('\n') : null});
  api.saveTask(task,root);
  return {...taskSummary(task,root),message:next==='READY_FOR_USER_TEST' ? '已实际打开且未观察到启动错误；业务功能交用户自行测试，不代表代码正确性通过。' : failed ? '仅按实际启动错误返工；不扩大为全面代码审查。' : '未能实际打开，不能记录已通过。'};
}

function guidanceFiles(repo) {
  const home=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  const choose=dir=>{
    const candidates=['AGENTS.override.md','AGENTS.md'].map(n=>path.join(dir,n));
    return {directory:dir,candidates:candidates.map(p=>({path:p,exists:fs.existsSync(p)})),selected:candidates.find(p=>{
      try{return fs.statSync(p).isFile() && fs.statSync(p).size>0;}catch{return false;}
    }) ?? null};
  };
  const files=[choose(home)];
  if (repo) files.push(choose(repo));
  return {files,note:'检查标准文件位置与优先级；本次进程不证明其他会话的实际加载记录，不读取自定义 fallback 配置。'};
}
function writableCondition(dir) {
  let parent=dir;
  while(!fs.existsSync(parent) && path.dirname(parent)!==parent) parent=path.dirname(parent);
  try { fs.accessSync(parent,fs.constants.W_OK); return {nearestExisting:parent,accessFlagWritable:true,writeVerified:false}; }
  catch(err) { return {nearestExisting:parent,accessFlagWritable:false,writeVerified:false,reason:err.code}; }
}
async function doctor(opts,statuses) {
  const attempt=fn=>{try{return fn();}catch(err){return {error:err.message};}};
  const storage=api.getStoragePaths ? api.getStoragePaths(opts['state-root']) : null;
  const storageReport=storage ? {...storage,stateCondition:writableCondition(storage.stateDir),worktreeCondition:writableCondition(storage.workspacesDir)} : null;
  if (opts['probe-write']) {
    if (!storage) throw new Error('存储模块不可用');
    api.initStorage(opts['state-root']);
    for (const dir of [storage.stateDir,storage.workspacesDir]) {
      const probe=path.join(dir,`.write-probe-${randomUUID()}`);
      try { fs.writeFileSync(probe,'probe',{flag:'wx',mode:0o600}); }
      finally { if(fs.existsSync(probe)) fs.unlinkSync(probe); }
    }
    storageReport.writeProbe='两目录写入并清理成功；未创建任务或工作树';
  }
  out({status:'DOCTOR_REPORT',node:process.version,nodeCompatible:Number(process.versions.node.split('.')[0])>=22,
    processGroupsSupported:process.platform!=='win32',modules:statuses,
    agy:attempt(()=>api.detectAgyExecutable({explicitPath:opts.agy})),
    codex:attempt(()=>api.detectCodexExecutable({explicitPath:opts.codex})),storage:storageReport,
    guidance:guidanceFiles(opts.repo ? repository(opts.repo) : undefined),
    runtimeModelAccess:'NOT_VERIFIED_RUNTIME',notice:'doctor 仅诊断导入/接口/权限条件，不启动模型，也不运行自动化测试。'});
}
async function main() {
  const {cmd,opts}=parseArgs();
  if(cmd==='help') {process.stdout.write(HELP);return;}
  const statuses=await loadModules(cmd==='doctor', ['doctor','review','review-agent'].includes(cmd) || opts['code-review']===true);
  if(cmd==='doctor') {await doctor(opts,statuses);return;}
  const root=opts['state-root'];
  if(cmd==='plan') {
    if(opts.file && opts.workorder) throw new Error('--file 与 --workorder 不可同时提供');
    let plan;
    if(opts.file || opts.workorder) {
      if(['repo','goal','scope','max-repair-rounds','max-consecutive-failures','max-no-progress-rounds','review-mode','task-kind','agy-permission-policy'].some(k=>Object.hasOwn(opts,k))) throw new Error('文件工作单与单项参数不可混用');
      plan=api.loadWorkOrderFile(opts.file || opts.workorder);
    } else plan=api.planWork({repo:required(opts,'repo'),goal:required(opts,'goal'),scope:required(opts,'scope'),
      maxRepairRounds:countOption(opts['max-repair-rounds'],2),maxConsecutiveFailures:countOption(opts['max-consecutive-failures'],2),
      maxNoProgressRounds:countOption(opts['max-no-progress-rounds'],2),
      ...(opts['review-mode'] ? {reviewMode:opts['review-mode']} : {}),
      ...(opts['task-kind'] ? {taskKind:opts['task-kind']} : {}),
      ...(opts['agy-permission-policy'] ? {agyPermissionPolicy:opts['agy-permission-policy']} : {})
    });
    plan.repo=repository(plan.repo);
    const task=api.newTask(plan,git(plan.repo,['rev-parse','HEAD'])); api.saveTask(task,root);
    out({id:task.id,status:task.status,repo:plan.repo,baseCommit:task.baseCommit,scope:plan.scope,acceptance:plan.acceptance,
      taskKind:plan.taskKind,agyPermissionPolicy:plan.agyPermissionPolicy,executionPolicy:api.resolveExecutionPolicy(plan),
      note:'仅登记任务；原工作区未提交修改不会复制到隔离树。'});return;
  }
  if(cmd==='list') {
    out({tasks:api.listTasks(root).map(item=>item.corrupted ? item : {...taskSummary(item.task,root),goal:item.task.plan.goal})});return;
  }
  const id=required(opts,'id');
  if (['run', 'auto'].includes(cmd)) {
    const handoff = codexOnlyHandoff(api.loadTask(id, root));
    if (handoff) { out(handoff); return; }
  }
  if(cmd==='status') {out(taskSummary(api.loadTask(id,root),root));return;}
  if(cmd==='inspect') {
    const task=api.loadTask(id,root);
    if(opts['code-review']) out(packetFor(task,root));
    else if(opts['delivery']) {
      if (task.plan.reviewMode === 'CODEX_DELIVERY_CHECK' && task.deliveryChecklist) {
        out({
          taskId: task.id,
          deliveryRevision: task.deliveryRevision,
          statusCounts: api.computeStatusCounts(task.deliveryChecklist),
          deliveryChecklist: task.deliveryChecklist
        });
      } else {
        out(task.workerResult?.deliveryReport ?? {error:'尚无结构化交付清单'});
      }
    }
    else out(functionalHandoff(task,root));
    return;
  }
  if(cmd==='report') {
    const format = opts.format || 'markdown';
    if (!['json', 'markdown'].includes(format)) throw new Error('报告格式仅支持 json 或 markdown');
    const task = api.loadTask(id, root);
    const content = api.generateDeliveryReport(task, format);
    if (opts.file) {
      const targetFile = path.resolve(opts.file);
      if (fs.existsSync(targetFile)) throw new Error(`目标文件已存在，拒绝静默覆盖：${targetFile}`);
      const dir = path.dirname(targetFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
      fs.writeFileSync(targetFile, contentStr, 'utf8');
      out({ status: 'REPORT_SAVED', path: targetFile, format });
    } else {
      if (format === 'json') out(content);
      else process.stdout.write(content + '\n');
    }
    return;
  }
  if(cmd==='recover') {out(taskSummary(api.recoverTask(id,required(opts,'reason'),root),root));return;}
  const workerTimeout=timeoutOption(opts['worker-timeout-ms'] ?? (cmd==='run' ? opts['timeout-ms'] : undefined));
  const reviewerTimeout=timeoutOption(opts['reviewer-timeout-ms'] ?? (cmd==='review-agent' ? opts['timeout-ms'] : undefined));
  await api.withTaskLock(id,root,async()=>{
    if(cmd==='acceptance') {
      const file = required(opts, 'file');
      const resolved = path.resolve(file);
      if (!fs.existsSync(resolved)) throw new Error(`用户反馈文件不存在：${resolved}`);
      if (fs.statSync(resolved).size > 1024 * 1024) throw new Error('用户反馈文件超过 1MB');
      const feedback = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      let task = api.loadTask(id, root);
      task = api.applyUserFeedback(task, feedback);
      api.saveTask(task, root);
      out(functionalHandoff(task, root));
      return;
    }
    if(cmd==='unblock') {
      const reqId = required(opts, 'requirement-id');
      const reason = required(opts, 'reason');
      let task = api.loadTask(id, root);
      task = api.unblockRequirement(task, reqId, reason);
      api.saveTask(task, root);
      out(functionalHandoff(task, root));
      return;
    }
    if(cmd==='confirm') {out(recordFunctionalCheck(id,root,opts));return;}
    if(cmd==='verify') {out(recordStartupCheck(id,root,opts));return;}
    if(cmd==='run') {
      const handoff=codexOnlyHandoff(api.loadTask(id,root));
      if(handoff) {out(handoff);return;}
      const executable=api.detectAgyExecutable({explicitPath:opts.agy}).path;
      out(functionalHandoff(await workerStep(id,root,executable,workerTimeout),root));return;
    }
    if(cmd==='review-agent') {
      const executable=api.detectCodexExecutable({explicitPath:opts.codex}).path;
      out(taskSummary(await reviewStep(id,root,executable,reviewerTimeout),root));return;
    }
    if(cmd==='review') {
      let task=api.loadTask(id,root);
      if(!api.canReview(task)) throw new Error(`当前状态不能提交审查：${task.status}`);
      if(!opts.file) {
        if(opts.decision?.toLowerCase()!=='blocked') throw new Error('PASS/CHANGES_REQUESTED 仅接受 --file 完整结构化报告');
        task=block(task,root,required(opts,'reason'));out(taskSummary(task,root));return;
      }
      if(opts.decision || opts.reason) throw new Error('--file 不可与 --decision/--reason 混用');
      const file=path.resolve(opts.file);
      if(fs.statSync(file).size>2*1024*1024) throw new Error('审查报告超过 2MB 限额');
      const report=JSON.parse(fs.readFileSync(file,'utf8'));
      const packet=packetFor(task,root);
      api.validateReviewResult(report,task,packet,root);
      snapshot(task,root);
      const started=Date.now();
      task=api.transition(task,'REVIEWING',{failurePhase:null,owner:{pid:process.pid,host:os.hostname(),startedAt:new Date().toISOString()},
        activeChild:{status:'NOT_STARTED',type:'manual',host:os.hostname(),startedAt:new Date().toISOString()}});
      api.saveTask(task,root);
      try {snapshot(task,root);task=commitReview(task,root,report,packet.snapshotHash,null,'CODEX_EXPLICIT_REPORT',started);}
      catch(err) {err.isSystemFailure=true;recordFailureAndThrow(id,root,'REVIEWER',err,started);}
      out(taskSummary(task,root));return;
    }
    if(cmd==='auto') {
      let task=api.loadTask(id,root);
      const handoff=codexOnlyHandoff(task);
      if(handoff) {out(handoff);return;}
      if(['READY_FOR_USER_TEST','AWAITING_USER_ACCEPTANCE','ACCEPTED','BLOCKED'].includes(task.status)) {out(functionalHandoff(task,root));return;}
      if(['RUNNING','REVIEWING'].includes(task.status)) throw new Error('任务仍在执行；先核实原进程，不自动重放');

      const isDeliveryMode = task.plan.reviewMode === 'CODEX_DELIVERY_CHECK';

      if (!isDeliveryMode) {
        // 区分旧源码审查反馈与当前启动/功能/清单返工反馈
        const isFunctionalFeedback = task.functionalCheck?.outcome === 'FUNCTIONAL_FAILED' && task.functionalCheck.workerAttempt === task.attempts;
        const isStartupFeedback = task.startupCheck?.outcome === 'STARTUP_FAILED' && task.startupCheck.workerAttempt === task.attempts;
        const isDeliveryFeedback = task.workerResult && task.workerResult.deliveryValidation && !task.workerResult.deliveryValidation.allImplemented;
        const isCurrentRework = isFunctionalFeedback || isStartupFeedback || isDeliveryFeedback;
        const legacyFeedback = task.status === 'CHANGES_REQUESTED' && !isCurrentRework && task.review?.decision === 'CHANGES_REQUESTED';
        const legacyReviewerFailure = task.status === 'FAILED' && task.failurePhase === 'REVIEWER';

        if(['AWAITING_CODEX_REVIEW','PASSED'].includes(task.status) || legacyFeedback || legacyReviewerFailure) {
          task=api.transition(task,'AWAITING_LAUNCH_CHECK',{plan:{...task.plan,reviewMode:'CODEX_STARTUP_CHECK'},
            findings:[],repairIntent:false,failurePhase:null,startupCheck:null});
          api.saveTask(task,root);
        }
        if(['AWAITING_FUNCTIONAL_CHECK','AWAITING_LAUNCH_CHECK'].includes(task.status)) {out(functionalHandoff(task,root));return;}
      }

      const agy=api.detectAgyExecutable({explicitPath:opts.agy}).path;

      // 自动补齐与编码循环：若清单未完成且预算未耗尽，自动继续原 Worker 会话补齐
      while(true) {
        if (isDeliveryMode) {
          const actionable = api.getActionableRequirements(task.deliveryChecklist);
          if (actionable.length === 0) {
            const counts = api.computeStatusCounts(task.deliveryChecklist);
            if (counts.ACCEPTED === counts.total) {
              task = api.transition(task, 'ACCEPTED', { failurePhase: null, owner: null, activeChild: null });
              api.saveTask(task, root);
            } else if (counts.READY_FOR_ACCEPTANCE > 0) {
              task = api.transition(task, 'AWAITING_USER_ACCEPTANCE', { failurePhase: null, owner: null, activeChild: null });
              api.saveTask(task, root);
            } else if (counts.BLOCKED > 0) {
              task = api.transition(task, 'BLOCKED', { blockedReason: '所有待处理需求均处于受阻状态', failurePhase: null, owner: null, activeChild: null });
              api.saveTask(task, root);
            }
            out(functionalHandoff(task, root));
            return;
          }
        }

        if(!api.canRunWorker(task)) throw new Error(`当前状态不能进入编码流程：${task.status}`);
        task=await workerStep(id,root,agy,workerTimeout);

        if(['AWAITING_USER_ACCEPTANCE','ACCEPTED','AWAITING_FUNCTIONAL_CHECK','AWAITING_LAUNCH_CHECK','READY_FOR_USER_TEST','BLOCKED'].includes(task.status)) {
          out(functionalHandoff(task,root));
          return;
        }

        if(task.status==='CHANGES_REQUESTED') {
          // 清单未完成或存在缺项，且在原会话中，继续由原 Worker 会话补齐
          continue;
        }

        out(functionalHandoff(task,root));
        return;
      }
    }
  });
}
main().catch(err=>{out({status:'ERROR',code:err.code || 'ERR_SUPERAGENT',message:err.message});process.exitCode=1;});

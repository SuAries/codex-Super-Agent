/**
 * SuperAgent Default Delivery & User Manual Acceptance Workflow
 * Engine 0.7.0 / Collaboration Protocol 4.0
 * Pure helper module implementing data models, merge, acceptance, progress, and report contracts.
 */

export const ENGINE_VERSION = '0.7.0';
export const PROTOCOL_VERSION = '4.0';
export const DEFAULT_REVIEW_MODE = 'CODEX_DELIVERY_CHECK';
export const DEFAULT_MAX_NO_PROGRESS_ROUNDS = 2;

export const CANONICAL_STATUSES = Object.freeze([
  'TODO',
  'IN_PROGRESS',
  'PARTIAL',
  'READY_FOR_ACCEPTANCE',
  'BLOCKED',
  'ACCEPTED',
  'REJECTED'
]);

export const WORKER_SETTABLE_STATUSES = Object.freeze([
  'TODO',
  'IN_PROGRESS',
  'PARTIAL',
  'READY_FOR_ACCEPTANCE',
  'BLOCKED'
]);

export const USER_SETTABLE_STATUSES = Object.freeze([
  'ACCEPTED',
  'REJECTED'
]);

const STATUS_RANK = Object.freeze({
  TODO: 0,
  IN_PROGRESS: 1,
  PARTIAL: 2,
  READY_FOR_ACCEPTANCE: 3,
  BLOCKED: 0,
  REJECTED: 0,
  ACCEPTED: 4
});

/**
 * 校验需求项依赖关系：
 * 1. dependsOn 必须为已知 requirementId
 * 2. 禁止自我依赖
 * 3. 禁止循环依赖
 */
export function validateDependencies(acceptance) {
  if (!Array.isArray(acceptance) || acceptance.length === 0) {
    throw new Error('acceptance 必须为非空数组');
  }

  const idSet = new Set();
  for (const item of acceptance) {
    if (!item || typeof item !== 'object') throw new Error('acceptance 元素必须为对象');
    const id = typeof item.requirementId === 'string' ? item.requirementId.trim() : '';
    if (!id) throw new Error('acceptance 元素缺少 requirementId');
    if (idSet.has(id)) throw new Error(`acceptance 存在重复的 requirementId: ${id}`);
    idSet.add(id);
  }

  const graph = new Map();
  for (const item of acceptance) {
    const id = item.requirementId.trim();
    const deps = Array.isArray(item.dependsOn)
      ? item.dependsOn.map(d => String(d).trim()).filter(Boolean)
      : [];

    for (const dep of deps) {
      if (dep === id) throw new Error(`需求项 [${id}] 不能依赖自身`);
      if (!idSet.has(dep)) throw new Error(`需求项 [${id}] 声明了未知的依赖项 [${dep}]`);
    }
    graph.set(id, deps);
  }

  // 检测循环依赖 (DFS 三色标记法: 0=未访问, 1=访问中, 2=已完成)
  const state = new Map(); // id -> 0 | 1 | 2
  const path = [];

  function visit(node) {
    state.set(node, 1);
    path.push(node);

    for (const dep of graph.get(node) || []) {
      const depState = state.get(dep) || 0;
      if (depState === 1) {
        const cyclePath = [...path.slice(path.indexOf(dep)), dep].join(' -> ');
        throw new Error(`验收项依赖存在循环依赖：${cyclePath}`);
      }
      if (depState === 0) {
        visit(dep);
      }
    }

    path.pop();
    state.set(node, 2);
  }

  for (const id of idSet) {
    if ((state.get(id) || 0) === 0) {
      visit(id);
    }
  }

  return true;
}

/**
 * 从 WorkOrder acceptance 初始化交付清单 (deliveryChecklist)
 */
export function initDeliveryChecklist(acceptance) {
  validateDependencies(acceptance);

  return acceptance.map(item => {
    let criteria = [];
    if (Array.isArray(item.acceptanceCriteria) && item.acceptanceCriteria.length > 0) {
      criteria = item.acceptanceCriteria.map(c => String(c).trim()).filter(Boolean);
    }
    if (criteria.length === 0) {
      criteria = [item.requirement.trim()];
    }

    return {
      requirementId: item.requirementId.trim(),
      requirement: item.requirement.trim(),
      acceptanceCriteria: criteria,
      parentRequirementId: item.parentRequirementId ? String(item.parentRequirementId).trim() : null,
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(d => String(d).trim()).filter(Boolean) : [],
      status: 'TODO',
      implementation: '',
      changedFiles: [],
      noChangeReason: null,
      selfChecks: [],
      manualTestSteps: [],
      expectedResult: '',
      remainingWork: [],
      remainingIssues: [],
      satisfiedCriteria: [],
      blocker: null,
      consecutiveNoProgressCount: 0,
      lastWorkerAttempt: 0
    };
  });
}

/**
 * 计算 7 种互斥状态统计，严格保证各状态之和等于需求总数 N
 */
export function computeStatusCounts(checklist) {
  if (!Array.isArray(checklist)) {
    return {
      total: 0,
      TODO: 0,
      IN_PROGRESS: 0,
      PARTIAL: 0,
      READY_FOR_ACCEPTANCE: 0,
      BLOCKED: 0,
      ACCEPTED: 0,
      REJECTED: 0
    };
  }

  const counts = {
    total: checklist.length,
    TODO: 0,
    IN_PROGRESS: 0,
    PARTIAL: 0,
    READY_FOR_ACCEPTANCE: 0,
    BLOCKED: 0,
    ACCEPTED: 0,
    REJECTED: 0
  };

  for (const item of checklist) {
    const s = item.status;
    if (Object.hasOwn(counts, s)) {
      counts[s]++;
    } else {
      throw new Error(`清单包含未知状态：${s}`);
    }
  }

  const sum = counts.TODO + counts.IN_PROGRESS + counts.PARTIAL +
              counts.READY_FOR_ACCEPTANCE + counts.BLOCKED +
              counts.ACCEPTED + counts.REJECTED;

  if (sum !== counts.total) {
    throw new Error(`状态统计不守恒：总计 ${counts.total}，但 7 种互斥状态之和为 ${sum}`);
  }

  return counts;
}

/**
 * 获取当前可推进的需求项 (Actionable Requirements)
 * 依赖项必须已处于 READY_FOR_ACCEPTANCE 或 ACCEPTED 状态；
 * 局部阻塞项不影响不依赖它的独立项推进。
 */
export function getActionableRequirements(checklist) {
  if (!Array.isArray(checklist)) return [];

  const readyOrAccepted = new Set(
    checklist
      .filter(it => it.status === 'READY_FOR_ACCEPTANCE' || it.status === 'ACCEPTED')
      .map(it => it.requirementId)
  );

  return checklist.filter(item => {
    if (item.status === 'ACCEPTED' || item.status === 'BLOCKED') return false;

    // 未完成状态 (TODO / IN_PROGRESS / PARTIAL / REJECTED)
    const isUnfinished = ['TODO', 'IN_PROGRESS', 'PARTIAL', 'REJECTED'].includes(item.status);

    // 虽标为 READY_FOR_ACCEPTANCE 但缺失必要交付字段
    const isIncompleteReady = item.status === 'READY_FOR_ACCEPTANCE' && (
      !item.implementation ||
      !item.expectedResult ||
      !Array.isArray(item.manualTestSteps) || item.manualTestSteps.length === 0 ||
      ((!Array.isArray(item.changedFiles) || item.changedFiles.length === 0) && !item.noChangeReason)
    );

    if (!isUnfinished && !isIncompleteReady) return false;

    // 检查前置依赖是否全部已交付或已验收
    const deps = item.dependsOn || [];
    return deps.every(depId => readyOrAccepted.has(depId));
  });
}

/**
 * 判断需求项在两次尝试之间是否取得实质进展
 * 基于状态位推进、验收条件满足增加、遗留工作减少或有效代码变更，而非改变摘要措辞或 Token 数
 */
export function checkItemProgress(oldItem, newItem) {
  if (!oldItem) return true;

  const oldRank = STATUS_RANK[oldItem.status] ?? 0;
  const newRank = STATUS_RANK[newItem.status] ?? 0;

  // 1. 状态位推进 (如 TODO -> IN_PROGRESS -> PARTIAL -> READY_FOR_ACCEPTANCE)
  if (newRank > oldRank) return true;

  // 2. 已满足验收标准数量增加
  const oldSatCount = Array.isArray(oldItem.satisfiedCriteria) ? oldItem.satisfiedCriteria.length : 0;
  const newSatCount = Array.isArray(newItem.satisfiedCriteria) ? newItem.satisfiedCriteria.length : 0;
  if (newSatCount > oldSatCount) return true;

  // 3. 遗留工作项实质减少
  const oldRemCount = Array.isArray(oldItem.remainingWork) ? oldItem.remainingWork.length : 0;
  const newRemCount = Array.isArray(newItem.remainingWork) ? newItem.remainingWork.length : 0;
  if (oldRemCount > 0 && newRemCount < oldRemCount) return true;

  // 4. 有新的代码修改文件且提供了具体实现说明
  const oldFiles = new Set(Array.isArray(oldItem.changedFiles) ? oldItem.changedFiles : []);
  const newFiles = Array.isArray(newItem.changedFiles) ? newItem.changedFiles : [];
  const hasNewFiles = newFiles.some(f => !oldFiles.has(f));
  if (hasNewFiles && newItem.implementation && newItem.implementation.trim() !== (oldItem.implementation || '').trim()) {
    return true;
  }

  return false;
}

/**
 * 校验并标准化 Worker 提交的交付包 (FULL 或 DELTA)
 */
export function validateWorkerEnvelope(envelope, currentChecklist, currentRevision) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Worker 交付报告必须为有效 JSON 对象');
  }

  const reportKind = envelope.reportKind ? String(envelope.reportKind).trim().toUpperCase() : (currentRevision === 0 ? 'FULL' : 'DELTA');
  if (!['FULL', 'DELTA'].includes(reportKind)) {
    throw new Error(`交付类型 reportKind 非法：${envelope.reportKind}（仅支持 FULL 或 DELTA）`);
  }

  const baseRevision = Number.isInteger(envelope.baseRevision) ? envelope.baseRevision : (currentRevision === 0 ? 0 : currentRevision);

  // 首轮必须为 FULL，baseRevision 为 0
  if (currentRevision === 0) {
    if (reportKind !== 'FULL') {
      throw new Error('首轮交付必须使用 FULL 完整清单（覆盖全部已登记需求）');
    }
    if (baseRevision !== 0) {
      throw new Error(`首轮交付基线版本 baseRevision 必须为 0，当前收到: ${baseRevision}`);
    }
  } else {
    // 后续轮次若提供 baseRevision，必须与当前版本一致，拒绝陈旧版本
    if (envelope.baseRevision !== undefined && envelope.baseRevision !== currentRevision) {
      throw new Error(`交付基线版本陈旧（当前版本: Rev ${currentRevision}，上报版本: Rev ${envelope.baseRevision}）；请在最新状态上增量交付`);
    }
  }

  if (!Array.isArray(envelope.delivery)) {
    throw new Error('交付报告缺少 delivery 数组');
  }

  const expectedIds = new Map(currentChecklist.map(item => [item.requirementId, item]));
  const seenIds = new Set();

  for (let i = 0; i < envelope.delivery.length; i++) {
    const item = envelope.delivery[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`delivery[${i}] 必须为有效对象`);
    }

    const reqId = typeof item.requirementId === 'string' ? item.requirementId.trim() : '';
    if (!reqId) throw new Error(`delivery[${i}] 缺少 requirementId`);
    if (!expectedIds.has(reqId)) throw new Error(`delivery 包含未知 requirementId: ${reqId}`);
    if (seenIds.has(reqId)) throw new Error(`delivery 存在重复的 requirementId: ${reqId}`);
    seenIds.add(reqId);

    const status = typeof item.status === 'string' ? item.status.trim().toUpperCase() : '';
    if (!WORKER_SETTABLE_STATUSES.includes(status)) {
      if (USER_SETTABLE_STATUSES.includes(status)) {
        throw new Error(`Worker 严禁自报 [${status}] 状态；需求 [${reqId}] 的最终验收/驳回权仅归属于用户`);
      }
      throw new Error(`需求 [${reqId}] 状态非法: ${item.status}（Worker 仅可设置: ${WORKER_SETTABLE_STATUSES.join(', ')}）`);
    }

    const orig = expectedIds.get(reqId);

    // DELTA 校验 oldStatus 是否与当前状态一致
    if (reportKind === 'DELTA' && item.oldStatus) {
      const declaredOld = String(item.oldStatus).trim().toUpperCase();
      if (declaredOld !== orig.status) {
        throw new Error(`需求 [${reqId}] 声明的旧状态 [${declaredOld}] 与当前记录状态 [${orig.status}] 不符`);
      }
    }

    // Worker 不得篡改原始需求与验收标准
    if (item.requirement !== undefined && item.requirement.trim() !== orig.requirement) {
      throw new Error(`需求 [${reqId}] 不得修改原始需求描述`);
    }
    if (Array.isArray(item.acceptanceCriteria)) {
      const origCr = orig.acceptanceCriteria.join('|||');
      const itemCr = item.acceptanceCriteria.map(c => String(c).trim()).join('|||');
      if (origCr !== itemCr) {
        throw new Error(`需求 [${reqId}] 不得修改原始验收标准`);
      }
    }

    // READY_FOR_ACCEPTANCE 严格条件校验
    if (status === 'READY_FOR_ACCEPTANCE') {
      const sat = Array.isArray(item.satisfiedCriteria) ? item.satisfiedCriteria : [];
      const totalCriteria = orig.acceptanceCriteria.length;
      const allSatisfied = totalCriteria > 0 && Array.from({ length: totalCriteria }, (_, idx) => idx).every(idx => sat.includes(idx));
      if (!allSatisfied) {
        throw new Error(`需求 [${reqId}] 声明 READY_FOR_ACCEPTANCE，但 satisfiedCriteria 未覆盖全部验收标准 (需覆盖 0..${totalCriteria - 1})`);
      }

      if (Array.isArray(item.remainingWork) && item.remainingWork.length > 0) {
        throw new Error(`需求 [${reqId}] 声明 READY_FOR_ACCEPTANCE，但仍存在遗留工作 remainingWork: ${item.remainingWork.join('; ')}`);
      }

      if (item.blocker) {
        throw new Error(`需求 [${reqId}] 声明 READY_FOR_ACCEPTANCE，但仍声明了 blocker 阻塞`);
      }

      const impl = typeof item.implementation === 'string' ? item.implementation.trim() : '';
      if (!impl) {
        throw new Error(`需求 [${reqId}] 处于 READY_FOR_ACCEPTANCE 状态，必须提供 implementation 实现说明`);
      }

      const steps = Array.isArray(item.manualTestSteps) ? item.manualTestSteps : [];
      if (steps.length === 0) {
        throw new Error(`需求 [${reqId}] 处于 READY_FOR_ACCEPTANCE 状态，必须提供至少一步用户 manualTestSteps 手动测试步骤`);
      }

      const expRes = typeof item.expectedResult === 'string' ? item.expectedResult.trim() : '';
      if (!expRes) {
        throw new Error(`需求 [${reqId}] 处于 READY_FOR_ACCEPTANCE 状态，必须提供 expectedResult 预期结果`);
      }

      const files = Array.isArray(item.changedFiles) ? item.changedFiles.filter(Boolean) : [];
      const noChange = typeof item.noChangeReason === 'string' ? item.noChangeReason.trim() : '';
      if (files.length === 0 && !noChange) {
        throw new Error(`需求 [${reqId}] 缺少修改文件列表 changedFiles；若确实无文件改动，必须填写 noChangeReason 说明理由`);
      }
    }

    // BLOCKED 校验
    if (status === 'BLOCKED') {
      const blocker = item.blocker;
      const reason = blocker?.reason || item.reason;
      if (!reason || typeof reason !== 'string' || !reason.trim()) {
        throw new Error(`需求 [${reqId}] 处于 BLOCKED 状态，必须说明具体的阻塞原因 (blocker.reason 或 reason)`);
      }
    }
  }

  // 首轮 FULL 必须覆盖全部预期需求项
  if (reportKind === 'FULL') {
    for (const [expId] of expectedIds) {
      if (!seenIds.has(expId)) {
        throw new Error(`首轮 FULL 交付遗漏需求项: ${expId}；必须完整覆盖所有已规划需求`);
      }
    }
  }

  return {
    reportKind,
    baseRevision,
    summary: typeof envelope.summary === 'string' ? envelope.summary.trim() : '',
    launch: envelope.launch || null,
    delivery: envelope.delivery
  };
}

/**
 * 将 Worker 提交的交付包合并入当前任务清单
 * 处理增量推进、未变化项保留、实质进展判定及无进展受限止损
 */
export function mergeDeliveryReport({
  currentChecklist,
  currentRevision = 0,
  workerEnvelope,
  workerAttempt = 1,
  maxNoProgressRounds = DEFAULT_MAX_NO_PROGRESS_ROUNDS
}) {
  const validated = validateWorkerEnvelope(workerEnvelope, currentChecklist, currentRevision);
  const deliveryMap = new Map(validated.delivery.map(d => [d.requirementId.trim(), d]));

  const nextChecklist = [];
  const transitions = [];
  let blockedCountDueToNoProgress = 0;

  for (const orig of currentChecklist) {
    const reportItem = deliveryMap.get(orig.requirementId);

    // 未上报项直接沿用已有记录
    if (!reportItem) {
      nextChecklist.push({ ...orig });
      continue;
    }

    // 已被用户 ACCEPTED 的项若未被显式驳回，Worker 不能静默回退
    if (orig.status === 'ACCEPTED' && reportItem.status !== 'ACCEPTED') {
      nextChecklist.push({ ...orig });
      continue;
    }

    const newStatus = reportItem.status.trim().toUpperCase();
    const oldStatus = orig.status;

    // 构建候选更新记录
    const rawFiles = Array.isArray(reportItem.changedFiles) ? reportItem.changedFiles.map(f => String(f).trim()).filter(Boolean) : orig.changedFiles;
    const noChangeReason = typeof reportItem.noChangeReason === 'string' ? reportItem.noChangeReason.trim() : (rawFiles.length === 0 ? orig.noChangeReason : null);

    const selfChecks = Array.isArray(reportItem.selfChecks) ? reportItem.selfChecks.map(sc => ({
      action: String(sc.action || '').trim(),
      status: ['PASSED', 'FAILED', 'NOT_RUN'].includes(sc.status) ? sc.status : 'NOT_RUN',
      result: String(sc.result || '').trim()
    })) : orig.selfChecks;

    const manualTestSteps = Array.isArray(reportItem.manualTestSteps) ? reportItem.manualTestSteps.map(st => ({
      action: String(st.action || '').trim(),
      expected: String(st.expected || '').trim()
    })) : orig.manualTestSteps;

    const blocker = newStatus === 'BLOCKED' ? (
      reportItem.blocker ? {
        reason: String(reportItem.blocker.reason || reportItem.reason || '').trim(),
        impact: Array.isArray(reportItem.blocker.impact) ? reportItem.blocker.impact : [orig.requirementId],
        attempted: Array.isArray(reportItem.blocker.attempted) ? reportItem.blocker.attempted : [],
        owner: String(reportItem.blocker.owner || 'WORKER').trim(),
        requiredAssistance: String(reportItem.blocker.requiredAssistance || reportItem.unblockConditions || '').trim(),
        resumeWhen: String(reportItem.blocker.resumeWhen || reportItem.unblockConditions || '').trim()
      } : {
        reason: String(reportItem.reason || '未提供具体阻塞原因').trim(),
        impact: [orig.requirementId],
        attempted: [],
        owner: 'WORKER',
        requiredAssistance: String(reportItem.unblockConditions || '').trim(),
        resumeWhen: String(reportItem.unblockConditions || '').trim()
      }
    ) : null;

    const candidate = {
      ...orig,
      status: newStatus,
      implementation: typeof reportItem.implementation === 'string' ? reportItem.implementation.trim() : orig.implementation,
      changedFiles: rawFiles,
      noChangeReason,
      selfChecks,
      manualTestSteps,
      expectedResult: typeof reportItem.expectedResult === 'string' ? reportItem.expectedResult.trim() : orig.expectedResult,
      remainingWork: Array.isArray(reportItem.remainingWork) ? reportItem.remainingWork.map(w => String(w).trim()).filter(Boolean) : [],
      remainingIssues: Array.isArray(reportItem.remainingIssues) ? reportItem.remainingIssues.map(i => String(i).trim()).filter(Boolean) : [],
      satisfiedCriteria: Array.isArray(reportItem.satisfiedCriteria) ? [...new Set(reportItem.satisfiedCriteria)] : orig.satisfiedCriteria,
      blocker,
      lastWorkerAttempt: workerAttempt
    };

    // 检查实质进展
    const madeProgress = checkItemProgress(orig, candidate);
    let consecutiveNoProgress = orig.consecutiveNoProgressCount || 0;

    if (madeProgress) {
      consecutiveNoProgress = 0;
    } else {
      consecutiveNoProgress += 1;
    }

    // 连续两次无实质进展且尚未就绪/验收：停止机械重试，仅将受影响单项标记为 BLOCKED
    if (consecutiveNoProgress >= maxNoProgressRounds && candidate.status !== 'READY_FOR_ACCEPTANCE' && candidate.status !== 'ACCEPTED') {
      candidate.status = 'BLOCKED';
      candidate.blocker = {
        reason: `同一需求连续 ${maxNoProgressRounds} 轮补齐尝试无实质进展`,
        impact: [candidate.requirementId],
        attempted: [{ action: 'Worker 连续补齐', result: '状态与已满足标准未取得实质进展' }],
        owner: 'WORKER',
        requiredAssistance: '需要用户或人工重新澄清需求或调整实现方案',
        resumeWhen: '显式 unblock 或更新需求描述'
      };
      blockedCountDueToNoProgress++;
    }

    candidate.consecutiveNoProgressCount = consecutiveNoProgress;

    transitions.push({
      requirementId: candidate.requirementId,
      oldStatus,
      newStatus: candidate.status,
      madeProgress
    });

    nextChecklist.push(candidate);
  }

  const newRevision = currentRevision + 1;
  const deliveryHistoryEntry = {
    revision: newRevision,
    timestamp: new Date().toISOString(),
    workerAttempt,
    reportKind: validated.reportKind,
    summary: validated.summary,
    launch: validated.launch,
    transitions
  };

  const statusCounts = computeStatusCounts(nextChecklist);
  const actionable = getActionableRequirements(nextChecklist);

  return {
    updatedChecklist: nextChecklist,
    newRevision,
    deliveryHistoryEntry,
    statusCounts,
    hasActionable: actionable.length > 0,
    actionableCount: actionable.length,
    allReadyOrAccepted: statusCounts.READY_FOR_ACCEPTANCE + statusCounts.ACCEPTED === statusCounts.total,
    allAccepted: statusCounts.ACCEPTED === statusCounts.total,
    blockedCountDueToNoProgress
  };
}

/**
 * 记录用户显式验收/驳回事件
 * 只有用户反馈能将项标记为 ACCEPTED 或 REJECTED
 */
export function applyUserFeedback(task, feedback) {
  if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) {
    throw new Error('用户反馈必须为有效 JSON 对象');
  }

  if (feedback.confirmedBy !== 'USER') {
    throw new Error(`confirmedBy 必须为 "USER"，当前提供: ${feedback.confirmedBy}；Agent 严禁代签用户验收`);
  }

  if (feedback.taskId && feedback.taskId !== task.id) {
    throw new Error(`用户反馈绑定的 taskId (${feedback.taskId}) 与当前任务 ID (${task.id}) 不一致`);
  }

  const currentRev = task.deliveryRevision ?? 0;
  if (feedback.checklistRevision !== undefined && feedback.checklistRevision !== currentRev) {
    throw new Error(`用户反馈基线版本陈旧（当前清单版本: Rev ${currentRev}，反馈版本: Rev ${feedback.checklistRevision}）；请重新获取最新报告核对`);
  }

  if (!Array.isArray(feedback.decisions) || feedback.decisions.length === 0) {
    throw new Error('用户反馈 decisions 必须为非空决策数组');
  }

  const checklist = (task.deliveryChecklist || []).map(item => ({ ...item }));
  const itemMap = new Map(checklist.map(it => [it.requirementId, it]));

  const processedDecisions = [];
  const rejectedItems = [];

  for (let i = 0; i < feedback.decisions.length; i++) {
    const d = feedback.decisions[i];
    if (!d || typeof d !== 'object') throw new Error(`decisions[${i}] 必须为对象`);
    const reqId = typeof d.requirementId === 'string' ? d.requirementId.trim() : '';
    if (!reqId || !itemMap.has(reqId)) throw new Error(`decisions[${i}] 包含未知的 requirementId: ${reqId}`);

    const dec = typeof d.decision === 'string' ? d.decision.trim().toUpperCase() : '';
    if (!USER_SETTABLE_STATUSES.includes(dec)) {
      throw new Error(`decisions[${reqId}].decision 非法: ${d.decision}（仅支持 ACCEPTED 或 REJECTED）`);
    }

    const item = itemMap.get(reqId);

    if (dec === 'ACCEPTED') {
      if (item.status !== 'READY_FOR_ACCEPTANCE') {
        throw new Error(`需求 [${reqId}] 当前状态为 ${item.status}，仅 READY_FOR_ACCEPTANCE 状态可接受用户验收通过`);
      }
      item.status = 'ACCEPTED';
      item.userComment = d.comment ? String(d.comment).trim() : null;
      item.userAcceptedAt = new Date().toISOString();
    } else if (dec === 'REJECTED') {
      if (!['READY_FOR_ACCEPTANCE', 'ACCEPTED'].includes(item.status)) {
        throw new Error(`需求 [${reqId}] 当前状态为 ${item.status}，仅 READY_FOR_ACCEPTANCE 或 ACCEPTED 状态可被用户驳回`);
      }
      item.status = 'REJECTED';
      item.userComment = d.comment ? String(d.comment).trim() : '用户手动验收未通过';
      item.issueId = d.issueId ? String(d.issueId).trim() : null;
      item.userRejectedAt = new Date().toISOString();
      rejectedItems.push(item);
    }

    processedDecisions.push({
      requirementId: reqId,
      decision: dec,
      comment: d.comment ? String(d.comment).trim() : '',
      issueId: d.issueId ? String(d.issueId).trim() : null
    });
  }

  const feedbackRecord = {
    timestamp: new Date().toISOString(),
    confirmedBy: 'USER',
    userFeedback: typeof feedback.userFeedback === 'string' ? feedback.userFeedback.trim() : '',
    checklistRevision: currentRev,
    decisions: processedDecisions
  };

  const updatedTask = {
    ...task,
    deliveryChecklist: checklist,
    acceptanceHistory: [...(task.acceptanceHistory || []), feedbackRecord]
  };

  const counts = computeStatusCounts(checklist);

  // 根据最新清单更新任务级状态
  if (counts.REJECTED > 0) {
    updatedTask.status = 'CHANGES_REQUESTED';
    updatedTask.repairIntent = true;
    updatedTask.findings = rejectedItems.map(it => ({
      severity: 'HIGH',
      path: Array.isArray(it.changedFiles) && it.changedFiles[0] ? it.changedFiles[0] : 'unknown',
      location: '1',
      problem: `用户手动验收驳回 [${it.requirementId}]: ${it.userComment || '未满足预期'}`,
      impact: '用户手动验收未通过，需针对性返工',
      requestedFix: `修复需求 [${it.requirementId}]，使其完全符合验收标准: ${it.acceptanceCriteria.join('; ')}`
    }));
  } else if (counts.ACCEPTED === counts.total) {
    updatedTask.status = 'ACCEPTED';
    updatedTask.repairIntent = false;
    updatedTask.findings = [];
  } else if (counts.READY_FOR_ACCEPTANCE > 0) {
    updatedTask.status = 'AWAITING_USER_ACCEPTANCE';
    updatedTask.repairIntent = false;
  } else if (counts.BLOCKED > 0 && counts.TODO === 0 && counts.IN_PROGRESS === 0 && counts.PARTIAL === 0) {
    updatedTask.status = 'BLOCKED';
    updatedTask.blockedReason = '所有未完成需求均处于受阻状态';
  } else {
    updatedTask.status = 'CHANGES_REQUESTED';
    updatedTask.repairIntent = true;
  }

  return updatedTask;
}

/**
 * 解除指定需求项的受阻状态
 * 重置为 TODO 并清空 blocker，允许后续重新调度实施
 */
export function unblockRequirement(task, requirementIds, reason) {
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw new Error('unblock 操作必须提供解除原因说明 --reason');
  }

  const ids = (Array.isArray(requirementIds) ? requirementIds : [requirementIds])
    .map(id => String(id).trim())
    .filter(Boolean);

  if (ids.length === 0) throw new Error('缺少要解除阻塞的 requirementId');

  const checklist = (task.deliveryChecklist || []).map(item => ({ ...item }));
  const itemMap = new Map(checklist.map(it => [it.requirementId, it]));

  for (const id of ids) {
    const item = itemMap.get(id);
    if (!item) throw new Error(`未找到需求项: ${id}`);
    if (item.status !== 'BLOCKED') {
      throw new Error(`需求项 [${id}] 当前并非 BLOCKED 状态 (${item.status})，无需解阻`);
    }

    item.status = 'TODO';
    item.blocker = null;
    item.consecutiveNoProgressCount = 0;
  }

  const unblockRecord = {
    timestamp: new Date().toISOString(),
    requirementIds: ids,
    reason: reason.trim()
  };

  const updatedTask = {
    ...task,
    deliveryChecklist: checklist,
    unblockHistory: [...(task.unblockHistory || []), unblockRecord]
  };

  if (updatedTask.status === 'BLOCKED') {
    updatedTask.status = 'CHANGES_REQUESTED';
    updatedTask.blockedReason = null;
    updatedTask.repairIntent = true;
  }

  return updatedTask;
}

/**
 * 生成符合规范第 8 节格式的最终交付与验收报告
 * 支持 markdown 和 json 两种输出格式
 */
export function generateDeliveryReport(task, format = 'markdown') {
  const checklist = task.deliveryChecklist || [];
  const counts = computeStatusCounts(checklist);
  const rev = task.deliveryRevision ?? 0;

  if (format === 'json') {
    return {
      taskId: task.id,
      goal: task.plan?.goal || '',
      reviewMode: task.plan?.reviewMode || DEFAULT_REVIEW_MODE,
      deliveryRevision: rev,
      statusCounts: counts,
      taskStatus: task.status,
      deliveryChecklist: checklist,
      acceptanceHistory: task.acceptanceHistory || [],
      deliveryHistory: task.deliveryHistory || []
    };
  }

  const unfinishedCount = counts.TODO + counts.IN_PROGRESS + counts.PARTIAL + counts.REJECTED;

  let md = `# SuperAgent 交付与用户验收报告\n\n`;
  md += `## 本轮任务概览\n`;
  md += `- 任务 ID：${task.id}\n`;
  md += `- 任务目标：${task.plan?.goal || '无'}\n`;
  md += `- 清单版本：Rev ${rev}\n`;
  md += `- 原始需求总数：${counts.total}\n`;
  md += `- 待用户验收（READY_FOR_ACCEPTANCE）：${counts.READY_FOR_ACCEPTANCE}\n`;
  md += `- 用户已验收（ACCEPTED）：${counts.ACCEPTED}\n`;
  md += `- 未完成（TODO / IN_PROGRESS / PARTIAL / REJECTED）：${unfinishedCount}\n`;
  md += `- 阻塞（BLOCKED）：${counts.BLOCKED}\n\n`;

  md += `## 逐项交付总览\n`;
  md += `| ID | 需求 | 开发状态 | 修改文件 | 用户验收 |\n`;
  md += `|---|---|---|---|---|\n`;

  for (const item of checklist) {
    const files = Array.isArray(item.changedFiles) && item.changedFiles.length > 0
      ? item.changedFiles.map(f => `\`${f}\``).join(', ')
      : (item.noChangeReason || '—');

    const acceptanceLabel = item.status === 'ACCEPTED' ? '已通过' :
      item.status === 'REJECTED' ? `已驳回 (${item.userComment || '未说明'})` :
      item.status === 'BLOCKED' ? '待解决' : '待验收';

    md += `| ${item.requirementId} | ${item.requirement} | ${item.status} | ${files} | ${acceptanceLabel} |\n`;
  }
  md += `\n`;

  md += `## 手动验收步骤\n`;
  const itemsWithSteps = checklist.filter(it => Array.isArray(it.manualTestSteps) && it.manualTestSteps.length > 0);
  if (itemsWithSteps.length === 0) {
    md += `暂无手动验收步骤。\n\n`;
  } else {
    for (const item of itemsWithSteps) {
      md += `### ${item.requirementId}｜${item.requirement}\n`;
      md += `- 验收标准：${item.acceptanceCriteria.join('; ')}\n`;
      md += `- 开发状态：${item.status}\n`;
      md += `- 实现说明：${item.implementation || '无'}\n`;

      const checks = Array.isArray(item.selfChecks) && item.selfChecks.length > 0
        ? item.selfChecks.map(sc => `${sc.action} → ${sc.status} (${sc.result || '无详情'})`).join('; ')
        : '未执行';
      md += `- agy 已执行自检：${checks}\n`;

      md += `- 操作步骤：\n`;
      item.manualTestSteps.forEach((st, idx) => {
        md += `  ${idx + 1}. ${st.action} → 预期: ${st.expected}\n`;
      });
      md += `- 预期结果：${item.expectedResult || '无'}\n\n`;
    }
  }

  const unfinishedOrBlocked = checklist.filter(it => ['TODO', 'IN_PROGRESS', 'PARTIAL', 'REJECTED', 'BLOCKED'].includes(it.status));
  if (unfinishedOrBlocked.length > 0) {
    md += `## 未完成与阻塞\n`;
    for (const item of unfinishedOrBlocked) {
      md += `### ${item.requirementId}｜${item.requirement}\n`;
      md += `- 当前状态：${item.status}\n`;
      if (item.status === 'BLOCKED') {
        const b = item.blocker || {};
        md += `- 阻塞原因：${b.reason || item.reason || '未提供'}\n`;
        md += `- 影响范围：${Array.isArray(b.impact) ? b.impact.join(', ') : item.requirementId}\n`;
        md += `- 所需协助：${b.requiredAssistance || item.unblockConditions || '等待人工介入'}\n`;
        md += `- 恢复条件：${b.resumeWhen || '解除外部阻塞或重新规划'}\n`;
      } else if (item.status === 'REJECTED') {
        md += `- 驳回说明：${item.userComment || '用户手动验收未通过'}\n`;
        md += `- 下一步：由原 Worker 会话针对性修复\n`;
      } else {
        const remaining = Array.isArray(item.remainingWork) && item.remainingWork.length > 0
          ? item.remainingWork.join('; ')
          : '待继续补齐实现';
        md += `- 尚缺：${remaining}\n`;
        md += `- 下一步：继续派发 agy 补齐\n`;
      }
      md += `\n`;
    }
  }

  md += `## 最终结论\n`;
  const devStatus = counts.BLOCKED > 0
    ? '存在阻塞'
    : (counts.READY_FOR_ACCEPTANCE === counts.total ? '全部待验收' : (counts.ACCEPTED === counts.total ? '全部已交付验收' : '部分待验收'));
  const userStatus = counts.ACCEPTED === counts.total ? '全部已验收通过' : '尚未完成（待用户逐项手动确认）';

  md += `- 开发交付状态：${devStatus}\n`;
  md += `- 用户最终验收状态：${userStatus}\n`;
  md += `- 说明：仅用户确认后才能将对应需求标记为 ACCEPTED；Agent 自检结果不能替代用户验收。\n`;

  return md;
}

/**
 * 格式化 CLI 输出的交付阶段交接信息
 */
export function deliveryHandoff(task) {
  const checklist = task.deliveryChecklist || [];
  const counts = computeStatusCounts(checklist);
  const rev = task.deliveryRevision ?? 0;

  let nextAction = null;
  let instruction = '';

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

  const launch = task.workerResult?.deliveryReport?.launch;
  let launchInstructions = task.workerResult?.responseSummary ?? null;
  if (launch) {
    if (typeof launch === 'string') launchInstructions = launch;
    else if (typeof launch === 'object') launchInstructions = JSON.stringify(launch);
  }

  return {
    id: task.id,
    status: task.status,
    deliveryRevision: rev,
    statusCounts: counts,
    nextAction,
    instruction,
    launchInstructions,
    deliveryChecklist: checklist,
    acceptanceHistory: task.acceptanceHistory || []
  };
}

/**
 * Scheduler：严格任务状态机与限额控制
 * 引入明确的 REVIEWING 阶段，杜绝状态机不一致与无限空转
 */
const ALLOWED_TRANSITIONS = {
  CREATED: ['RUNNING', 'BLOCKED'],
  RUNNING: ['AWAITING_USER_ACCEPTANCE', 'AWAITING_FUNCTIONAL_CHECK', 'AWAITING_LAUNCH_CHECK', 'AWAITING_CODEX_REVIEW', 'CHANGES_REQUESTED', 'FAILED', 'BLOCKED', 'ACCEPTED'],
  AWAITING_CODEX_REVIEW: ['AWAITING_FUNCTIONAL_CHECK', 'AWAITING_LAUNCH_CHECK', 'READY_FOR_USER_TEST', 'CHANGES_REQUESTED', 'REVIEWING', 'BLOCKED'],
  AWAITING_LAUNCH_CHECK: ['READY_FOR_USER_TEST', 'CHANGES_REQUESTED', 'REVIEWING', 'BLOCKED'],
  AWAITING_FUNCTIONAL_CHECK: ['READY_FOR_USER_TEST', 'CHANGES_REQUESTED', 'REVIEWING', 'BLOCKED'],
  AWAITING_USER_ACCEPTANCE: ['CHANGES_REQUESTED', 'ACCEPTED', 'BLOCKED', 'RUNNING'],
  READY_FOR_USER_TEST: ['BLOCKED'],
  REVIEWING: ['PASSED', 'CHANGES_REQUESTED', 'FAILED', 'BLOCKED'],
  CHANGES_REQUESTED: ['RUNNING', 'AWAITING_USER_ACCEPTANCE', 'AWAITING_FUNCTIONAL_CHECK', 'AWAITING_LAUNCH_CHECK', 'BLOCKED', 'ACCEPTED'],
  FAILED: ['RUNNING', 'REVIEWING', 'AWAITING_USER_ACCEPTANCE', 'AWAITING_FUNCTIONAL_CHECK', 'AWAITING_LAUNCH_CHECK', 'BLOCKED'],
  PASSED: ['AWAITING_FUNCTIONAL_CHECK', 'AWAITING_LAUNCH_CHECK', 'BLOCKED'], // 检测到工作树被外部篡改时标记作废
  ACCEPTED: ['CHANGES_REQUESTED', 'BLOCKED'],
  BLOCKED: ['RUNNING', 'REVIEWING', 'CHANGES_REQUESTED', 'AWAITING_USER_ACCEPTANCE'] // 仅在用户显式 retry/unblock 时可恢复
};

export function transition(task, nextStatus, patch = {}) {
  const allowed = ALLOWED_TRANSITIONS[task.status];
  if (!allowed || !allowed.includes(nextStatus)) {
    throw new Error(`非法状态转换：${task.status} → ${nextStatus}`);
  }

  return {
    ...task,
    ...patch,
    status: nextStatus,
    updatedAt: new Date().toISOString()
  };
}

export function canRunWorker(task) {
  if (task.status === 'CREATED' || task.status === 'CHANGES_REQUESTED') return true;
  if (task.status === 'FAILED' && task.failurePhase !== 'REVIEWER') return true;
  return false;
}

export function canReview(task) {
  if (['AWAITING_CODEX_REVIEW', 'AWAITING_LAUNCH_CHECK', 'AWAITING_FUNCTIONAL_CHECK'].includes(task.status)) return true;
  if (task.status === 'FAILED' && task.failurePhase === 'REVIEWER') return true;
  return false;
}

/**
 * 校验返工轮次预算
 */
export function ensureRepairBudget(task) {
  if (task.plan?.reviewMode === 'CODEX_DELIVERY_CHECK') {
    // 新默认模式不设全局任务级 2 次总返工上限，由单项连续两次无实质进展 (maxNoProgressRounds) 规则止损
    return;
  }
  const maxRounds = task.plan?.maxRepairRounds ?? 2;
  const currentRounds = task.repairRounds ?? 0;
  if (task.repairIntent && currentRounds >= maxRounds) {
    throw new Error(`已达到最大返工轮次上限 (${maxRounds} 轮)，任务停止并等待人工介入`);
  }
}

/**
 * 校验连续失败次数
 */
export function checkConsecutiveFailures(task) {
  const maxFailures = task.plan?.maxConsecutiveFailures ?? 2;
  const currentFailures = task.consecutiveFailures ?? 0;
  if (currentFailures >= maxFailures) {
    throw new Error(`已达到连续失败次数上限 (${maxFailures} 次)，受控止损终止`);
  }
}

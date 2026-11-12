import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINE_VERSION,
  PROTOCOL_VERSION,
  DEFAULT_REVIEW_MODE,
  CANONICAL_STATUSES,
  WORKER_SETTABLE_STATUSES,
  USER_SETTABLE_STATUSES,
  validateDependencies,
  initDeliveryChecklist,
  computeStatusCounts,
  getActionableRequirements,
  checkItemProgress,
  validateWorkerEnvelope,
  mergeDeliveryReport,
  applyUserFeedback,
  unblockRequirement,
  generateDeliveryReport,
  deliveryHandoff
} from '../task-store/delivery-workflow.mjs';
import { planWork } from '../router/index.mjs';
import { newTask, validateTaskObject } from '../task-store/index.mjs';
import { transition, canRunWorker, ensureRepairBudget } from '../scheduler/index.mjs';

test('Protocol and Engine Metadata', () => {
  assert.equal(ENGINE_VERSION, '0.7.0');
  assert.equal(PROTOCOL_VERSION, '4.0');
  assert.equal(DEFAULT_REVIEW_MODE, 'CODEX_DELIVERY_CHECK');
});

test('Dependency Validation: Valid DAG', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: '基线功能' },
    { requirementId: 'REQ-2', requirement: '依赖项功能', dependsOn: ['REQ-1'] },
    { requirementId: 'REQ-3', requirement: '多重依赖', dependsOn: ['REQ-1', 'REQ-2'] }
  ];
  assert.equal(validateDependencies(acceptance), true);
});

test('Dependency Validation: Rejects Unknown Dependency', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: '基线功能', dependsOn: ['UNKNOWN-99'] }
  ];
  assert.throws(() => validateDependencies(acceptance), /未知的依赖项/);
});

test('Dependency Validation: Rejects Self Dependency', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: '自身循环', dependsOn: ['REQ-1'] }
  ];
  assert.throws(() => validateDependencies(acceptance), /不能依赖自身/);
});

test('Dependency Validation: Rejects Circular Dependency', () => {
  const acceptance = [
    { requirementId: 'REQ-A', requirement: 'A', dependsOn: ['REQ-B'] },
    { requirementId: 'REQ-B', requirement: 'B', dependsOn: ['REQ-A'] }
  ];
  assert.throws(() => validateDependencies(acceptance), /循环依赖/);
});

test('WorkOrder Planning: Default Settings and Observable Criteria Fallback', () => {
  const plan = planWork({
    goal: '构建测试应用',
    repo: process.cwd(),
    scope: ['src/**'],
    acceptance: [
      { requirementId: 'REQ-1', requirement: '用户登录' },
      {
        requirementId: 'REQ-2',
        requirement: '数据导出',
        acceptanceCriteria: ['点击导出下载 CSV', 'CSV 内容格式正确'],
        dependsOn: ['REQ-1']
      }
    ]
  });

  assert.equal(plan.reviewMode, 'CODEX_DELIVERY_CHECK');
  assert.equal(plan.defaultRunAutomatedTests, true);
  assert.equal(plan.maxNoProgressRounds, 2);
  assert.equal(plan.acceptance[0].acceptanceCriteria[0], '用户登录');
  assert.equal(plan.acceptance[1].acceptanceCriteria.length, 2);
});

test('Delivery Checklist Initialization: Sets TODO Status and Canonical Fields', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: 'A' },
    { requirementId: 'REQ-2', requirement: 'B', dependsOn: ['REQ-1'] }
  ];
  const checklist = initDeliveryChecklist(acceptance);

  assert.equal(checklist.length, 2);
  assert.equal(checklist[0].status, 'TODO');
  assert.equal(checklist[0].consecutiveNoProgressCount, 0);
  assert.deepEqual(checklist[0].selfChecks, []);
  assert.deepEqual(checklist[0].manualTestSteps, []);
  assert.equal(checklist[0].blocker, null);
});

test('Worker Report Merge: First Turn MUST be FULL covering all IDs', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: '功能1' },
    { requirementId: 'REQ-2', requirement: '功能2' }
  ];
  const checklist = initDeliveryChecklist(acceptance);

  // Missing REQ-2 in FULL
  assert.throws(() => {
    mergeDeliveryReport({
      currentChecklist: checklist,
      currentRevision: 0,
      workerEnvelope: {
        reportKind: 'FULL',
        baseRevision: 0,
        summary: '部分完成',
        delivery: [
          {
            requirementId: 'REQ-1',
            status: 'IN_PROGRESS',
            implementation: '开发中'
          }
        ]
      }
    });
  }, /首轮 FULL 交付遗漏需求项/);

  // Complete FULL report
  const merged = mergeDeliveryReport({
    currentChecklist: checklist,
    currentRevision: 0,
    workerEnvelope: {
      reportKind: 'FULL',
      baseRevision: 0,
      summary: '首轮全部完成',
      delivery: [
        {
          requirementId: 'REQ-1',
          status: 'READY_FOR_ACCEPTANCE',
          implementation: '已实现REQ-1',
          changedFiles: ['src/a.js'],
          manualTestSteps: [{ action: '执行测试1', expected: '预期表现1' }],
          expectedResult: '功能1就绪',
          satisfiedCriteria: [0]
        },
        {
          requirementId: 'REQ-2',
          status: 'PARTIAL',
          implementation: '实现了一半',
          changedFiles: ['src/b.js'],
          remainingWork: ['还需补充后半部分']
        }
      ]
    }
  });

  assert.equal(merged.newRevision, 1);
  assert.equal(merged.updatedChecklist[0].status, 'READY_FOR_ACCEPTANCE');
  assert.equal(merged.updatedChecklist[1].status, 'PARTIAL');
  assert.equal(merged.statusCounts.READY_FOR_ACCEPTANCE, 1);
  assert.equal(merged.statusCounts.PARTIAL, 1);
});

test('Worker Forbidden Status: Worker Cannot Set ACCEPTED or REJECTED', () => {
  const checklist = initDeliveryChecklist([{ requirementId: 'REQ-1', requirement: 'A' }]);

  assert.throws(() => {
    mergeDeliveryReport({
      currentChecklist: checklist,
      currentRevision: 0,
      workerEnvelope: {
        reportKind: 'FULL',
        baseRevision: 0,
        delivery: [
          {
            requirementId: 'REQ-1',
            status: 'ACCEPTED',
            implementation: '尝试自报通过'
          }
        ]
      }
    });
  }, /Worker 严禁自报/);

  assert.throws(() => {
    mergeDeliveryReport({
      currentChecklist: checklist,
      currentRevision: 0,
      workerEnvelope: {
        reportKind: 'FULL',
        baseRevision: 0,
        delivery: [
          {
            requirementId: 'REQ-1',
            status: 'REJECTED',
            implementation: '尝试自报驳回'
          }
        ]
      }
    });
  }, /Worker 严禁自报/);
});

test('DELTA Report Merge: Incremental Changes and Stale Revision Check', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: '功能1' },
    { requirementId: 'REQ-2', requirement: '功能2' }
  ];
  let checklist = initDeliveryChecklist(acceptance);

  const fullMerge = mergeDeliveryReport({
    currentChecklist: checklist,
    currentRevision: 0,
    workerEnvelope: {
      reportKind: 'FULL',
      baseRevision: 0,
      delivery: [
        {
          requirementId: 'REQ-1',
          status: 'READY_FOR_ACCEPTANCE',
          implementation: '已实现',
          changedFiles: ['src/a.js'],
          manualTestSteps: [{ action: '测试', expected: 'OK' }],
          expectedResult: 'OK',
          satisfiedCriteria: [0]
        },
        {
          requirementId: 'REQ-2',
          status: 'TODO'
        }
      ]
    }
  });

  checklist = fullMerge.updatedChecklist;
  const currentRev = fullMerge.newRevision; // 1

  // Stale baseRevision should throw
  assert.throws(() => {
    mergeDeliveryReport({
      currentChecklist: checklist,
      currentRevision: currentRev,
      workerEnvelope: {
        reportKind: 'DELTA',
        baseRevision: 0, // Stale!
        delivery: [
          {
            requirementId: 'REQ-2',
            status: 'IN_PROGRESS',
            oldStatus: 'TODO'
          }
        ]
      }
    });
  }, /交付基线版本陈旧/);

  // Valid DELTA
  const deltaMerge = mergeDeliveryReport({
    currentChecklist: checklist,
    currentRevision: currentRev,
    workerEnvelope: {
      reportKind: 'DELTA',
      baseRevision: 1,
      delivery: [
        {
          requirementId: 'REQ-2',
          status: 'READY_FOR_ACCEPTANCE',
          oldStatus: 'TODO',
          implementation: 'REQ-2已实现',
          changedFiles: ['src/b.js'],
          manualTestSteps: [{ action: '操作REQ-2', expected: '成功' }],
          expectedResult: 'REQ-2成功',
          satisfiedCriteria: [0]
        }
      ]
    }
  });

  assert.equal(deltaMerge.newRevision, 2);
  assert.equal(deltaMerge.updatedChecklist[0].status, 'READY_FOR_ACCEPTANCE'); // Unchanged carried forward
  assert.equal(deltaMerge.updatedChecklist[1].status, 'READY_FOR_ACCEPTANCE'); // Updated
  assert.equal(deltaMerge.allReadyOrAccepted, true);
});

test('Actionable Continuation: Partial Blockers Do Not Stop Independent Items', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: '独立功能1' },
    { requirementId: 'REQ-2', requirement: '受阻功能' },
    { requirementId: 'REQ-3', requirement: '依赖受阻功能的项', dependsOn: ['REQ-2'] }
  ];
  let checklist = initDeliveryChecklist(acceptance);

  checklist[0].status = 'TODO';
  checklist[1].status = 'BLOCKED';
  checklist[1].blocker = { reason: '第三方接口未提供', impact: ['REQ-2'] };
  checklist[2].status = 'TODO';

  const actionable = getActionableRequirements(checklist);
  const actionableIds = actionable.map(it => it.requirementId);

  // REQ-1 is independent and actionable
  assert.ok(actionableIds.includes('REQ-1'));
  // REQ-2 is BLOCKED, not actionable
  assert.ok(!actionableIds.includes('REQ-2'));
  // REQ-3 depends on REQ-2 (which is BLOCKED, not ready), so REQ-3 is blocked from action
  assert.ok(!actionableIds.includes('REQ-3'));
});

test('No-Progress Detection: 2 Consecutive No-Progress Rounds Block Only Affected Item', () => {
  const acceptance = [
    { requirementId: 'REQ-1', requirement: '功能1' },
    { requirementId: 'REQ-2', requirement: '功能2' }
  ];
  let checklist = initDeliveryChecklist(acceptance);

  // First turn: PARTIAL
  const turn1 = mergeDeliveryReport({
    currentChecklist: checklist,
    currentRevision: 0,
    workerEnvelope: {
      reportKind: 'FULL',
      baseRevision: 0,
      delivery: [
        {
          requirementId: 'REQ-1',
          status: 'PARTIAL',
          implementation: '初始部分代码',
          changedFiles: ['src/1.js'],
          remainingWork: ['还有待办']
        },
        {
          requirementId: 'REQ-2',
          status: 'TODO'
        }
      ]
    }
  });
  checklist = turn1.updatedChecklist;
  assert.equal(checklist[0].consecutiveNoProgressCount, 0);

  // Turn 2: Attempt repair on REQ-1, but no progress (same status, same remainingWork, same files)
  const turn2 = mergeDeliveryReport({
    currentChecklist: checklist,
    currentRevision: turn1.newRevision,
    workerEnvelope: {
      reportKind: 'DELTA',
      baseRevision: turn1.newRevision,
      delivery: [
        {
          requirementId: 'REQ-1',
          status: 'PARTIAL',
          oldStatus: 'PARTIAL',
          implementation: '初始部分代码',
          changedFiles: ['src/1.js'],
          remainingWork: ['还有待办']
        }
      ]
    }
  });
  checklist = turn2.updatedChecklist;
  assert.equal(checklist[0].consecutiveNoProgressCount, 1);
  assert.equal(checklist[0].status, 'PARTIAL');

  // Turn 3: Second consecutive attempt with no progress -> auto-blocks REQ-1!
  const turn3 = mergeDeliveryReport({
    currentChecklist: checklist,
    currentRevision: turn2.newRevision,
    workerEnvelope: {
      reportKind: 'DELTA',
      baseRevision: turn2.newRevision,
      delivery: [
        {
          requirementId: 'REQ-1',
          status: 'PARTIAL',
          oldStatus: 'PARTIAL',
          implementation: '初始部分代码',
          changedFiles: ['src/1.js'],
          remainingWork: ['还有待办']
        }
      ]
    }
  });
  checklist = turn3.updatedChecklist;
  assert.equal(checklist[0].status, 'BLOCKED');
  assert.ok(checklist[0].blocker.reason.includes('连续 2 轮补齐尝试无实质进展'));

  // Independent REQ-2 is STILL runnable!
  const actionable = getActionableRequirements(checklist);
  assert.equal(actionable.length, 1);
  assert.equal(actionable[0].requirementId, 'REQ-2');
});

test('Explicit User Feedback: Only User Can ACCEPT or REJECT', () => {
  const plan = planWork({
    goal: '用户反馈测试',
    repo: process.cwd(),
    scope: ['src/**'],
    acceptance: [
      { requirementId: 'REQ-1', requirement: '登录' },
      { requirementId: 'REQ-2', requirement: '注册' }
    ]
  });

  const task = newTask(plan, '0123456789abcdef0123456789abcdef01234567');
  task.deliveryChecklist[0].status = 'READY_FOR_ACCEPTANCE';
  task.deliveryChecklist[0].implementation = '完成登录';
  task.deliveryChecklist[0].manualTestSteps = [{ action: '输入密码', expected: '成功' }];
  task.deliveryChecklist[0].expectedResult = '成功';
  task.deliveryChecklist[0].changedFiles = ['src/auth.js'];
  task.deliveryChecklist[0].satisfiedCriteria = [0];

  task.deliveryChecklist[1].status = 'READY_FOR_ACCEPTANCE';
  task.deliveryChecklist[1].implementation = '完成注册';
  task.deliveryChecklist[1].manualTestSteps = [{ action: '注册', expected: '成功' }];
  task.deliveryChecklist[1].expectedResult = '成功';
  task.deliveryChecklist[1].changedFiles = ['src/reg.js'];
  task.deliveryChecklist[1].satisfiedCriteria = [0];

  task.deliveryRevision = 1;

  // Stale revision rejection
  assert.throws(() => {
    applyUserFeedback(task, {
      confirmedBy: 'USER',
      checklistRevision: 0, // Stale!
      decisions: [{ requirementId: 'REQ-1', decision: 'ACCEPTED' }]
    });
  }, /用户反馈基线版本陈旧/);

  // Agent cannot sign
  assert.throws(() => {
    applyUserFeedback(task, {
      confirmedBy: 'CODEX',
      checklistRevision: 1,
      decisions: [{ requirementId: 'REQ-1', decision: 'ACCEPTED' }]
    });
  }, /confirmedBy 必须为 "USER"/);

  // User accepts REQ-1, rejects REQ-2
  const updated = applyUserFeedback(task, {
    confirmedBy: 'USER',
    userFeedback: 'REQ-1验证通过，REQ-2验证失败',
    checklistRevision: 1,
    decisions: [
      { requirementId: 'REQ-1', decision: 'ACCEPTED', comment: '功能良好' },
      { requirementId: 'REQ-2', decision: 'REJECTED', comment: '验证码无法收到' }
    ]
  });

  assert.equal(updated.deliveryChecklist[0].status, 'ACCEPTED');
  assert.equal(updated.deliveryChecklist[1].status, 'REJECTED');
  assert.equal(updated.status, 'CHANGES_REQUESTED');
  assert.equal(updated.repairIntent, true);
  assert.equal(updated.findings.length, 1);
  assert.ok(updated.findings[0].problem.includes('验证码无法收到'));

  // Now user accepts the fixed REQ-2
  updated.deliveryChecklist[1].status = 'READY_FOR_ACCEPTANCE';
  const allAccepted = applyUserFeedback(updated, {
    confirmedBy: 'USER',
    userFeedback: '全部通过',
    checklistRevision: 1,
    decisions: [
      { requirementId: 'REQ-2', decision: 'ACCEPTED', comment: '修复后验证通过' }
    ]
  });

  assert.equal(allAccepted.status, 'ACCEPTED');
  assert.equal(allAccepted.deliveryChecklist[0].status, 'ACCEPTED');
  assert.equal(allAccepted.deliveryChecklist[1].status, 'ACCEPTED');
});

test('Unblock Command: Resets Blocked Item for New Work', () => {
  const plan = planWork({
    goal: '解阻测试',
    repo: process.cwd(),
    scope: ['src/**'],
    acceptance: [{ requirementId: 'REQ-1', requirement: '网络接口' }]
  });
  const task = newTask(plan, '0123456789abcdef0123456789abcdef01234567');
  task.deliveryChecklist[0].status = 'BLOCKED';
  task.deliveryChecklist[0].blocker = { reason: '网络不可用' };
  task.status = 'BLOCKED';

  const unblocked = unblockRequirement(task, 'REQ-1', '网络已恢复连接');

  assert.equal(unblocked.deliveryChecklist[0].status, 'TODO');
  assert.equal(unblocked.deliveryChecklist[0].blocker, null);
  assert.equal(unblocked.status, 'CHANGES_REQUESTED');
  assert.equal(unblocked.unblockHistory.length, 1);
  assert.equal(unblocked.unblockHistory[0].reason, '网络已恢复连接');
});

test('Count Conservation: 7 Canonical Statuses Sum strictly Equals N', () => {
  const checklist = [
    { status: 'TODO' },
    { status: 'IN_PROGRESS' },
    { status: 'PARTIAL' },
    { status: 'READY_FOR_ACCEPTANCE' },
    { status: 'BLOCKED' },
    { status: 'ACCEPTED' },
    { status: 'REJECTED' }
  ];
  const counts = computeStatusCounts(checklist);

  assert.equal(counts.total, 7);
  assert.equal(counts.TODO, 1);
  assert.equal(counts.IN_PROGRESS, 1);
  assert.equal(counts.PARTIAL, 1);
  assert.equal(counts.READY_FOR_ACCEPTANCE, 1);
  assert.equal(counts.BLOCKED, 1);
  assert.equal(counts.ACCEPTED, 1);
  assert.equal(counts.REJECTED, 1);

  const sum = counts.TODO + counts.IN_PROGRESS + counts.PARTIAL +
              counts.READY_FOR_ACCEPTANCE + counts.BLOCKED +
              counts.ACCEPTED + counts.REJECTED;
  assert.equal(sum, counts.total);
});

test('Delivery Report Generation: Markdown and JSON with Pending Separation', () => {
  const plan = planWork({
    goal: '报告测试',
    repo: process.cwd(),
    scope: ['src/**'],
    acceptance: [
      { requirementId: 'REQ-1', requirement: '基础界面' },
      { requirementId: 'REQ-2', requirement: '导出报表' }
    ]
  });
  const task = newTask(plan, '0123456789abcdef0123456789abcdef01234567');
  task.deliveryChecklist[0].status = 'READY_FOR_ACCEPTANCE';
  task.deliveryChecklist[0].implementation = '界面已渲染';
  task.deliveryChecklist[0].changedFiles = ['src/view.vue'];
  task.deliveryChecklist[0].manualTestSteps = [{ action: '访问首页', expected: '显示界面' }];
  task.deliveryChecklist[0].expectedResult = '界面展示正常';
  task.deliveryChecklist[0].selfChecks = [{ action: 'pnpm build', status: 'PASSED', result: '无报错' }];

  task.deliveryChecklist[1].status = 'BLOCKED';
  task.deliveryChecklist[1].blocker = {
    reason: '第三方组件缺失',
    impact: ['REQ-2'],
    requiredAssistance: '提供依赖包',
    resumeWhen: '安装依赖后'
  };

  const mdReport = generateDeliveryReport(task, 'markdown');
  assert.ok(mdReport.includes('待用户验收（READY_FOR_ACCEPTANCE）：1'));
  assert.ok(mdReport.includes('阻塞（BLOCKED）：1'));
  assert.ok(mdReport.includes('pnpm build → PASSED'));
  assert.ok(mdReport.includes('用户最终验收状态：尚未完成'));

  const jsonReport = generateDeliveryReport(task, 'json');
  assert.equal(jsonReport.statusCounts.READY_FOR_ACCEPTANCE, 1);
  assert.equal(jsonReport.statusCounts.BLOCKED, 1);
});

test('Legacy State Compatibility: Schema 4 Validation Preserved', () => {
  const legacyTask = {
    schemaVersion: 4,
    id: '12345678-1234-1234-1234-1234567890ab',
    status: 'CREATED',
    failurePhase: null,
    repairIntent: false,
    plan: {
      repo: process.cwd(),
      goal: '旧任务',
      scope: ['src/**'],
      constraints: ['约束1'],
      acceptance: [{ requirementId: 'REQ-1', requirement: '旧需求' }],
      reviewMode: 'CODEX_STARTUP_CHECK',
      defaultRunAutomatedTests: false,
      maxRepairRounds: 2,
      maxConsecutiveFailures: 2
    },
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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
    workerResult: null
  };

  // Schema 4 task with CODEX_STARTUP_CHECK validates without requiring deliveryChecklist
  assert.equal(validateTaskObject(legacyTask, legacyTask.id, undefined), true);
});

import { spawn } from 'node:child_process';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REVIEWER_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_OUTPUT_BUFFER_BYTES = 4 * 1024 * 1024;
const TERM_GRACE_MS = 3000;
const KILL_CONFIRM_MS = 2000;

function executionError(code, message, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

export function createTimeout(timeoutMs = DEFAULT_WORKER_TIMEOUT_MS) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60 * 60 * 1000) {
    throw executionError('ERR_INVALID_TIMEOUT', 'timeoutMs 必须为 1 秒到 1 小时之间的整数', { isSystemFailure: true });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, close: () => clearTimeout(timer) };
}

/** Only ESRCH proves that a local process group no longer exists. */
export function processGroupLiveness(pgid, host = os.hostname()) {
  if (!Number.isSafeInteger(pgid) || pgid <= 0 || host !== os.hostname() || process.platform === 'win32') return 'UNKNOWN';
  try {
    process.kill(-pgid, 0);
    return 'ALIVE';
  } catch (err) {
    if (err.code === 'ESRCH') return 'DEAD';
    if (err.code === 'EPERM') return 'ALIVE';
    return 'UNKNOWN';
  }
}

/** A detached POSIX child owns its PGID. Completion includes all members of that group. */
export async function spawnManagedProcess({ executable, args = [], cwd,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS, stdinContent,
  maxBufferBytes = MAX_OUTPUT_BUFFER_BYTES, env, onSpawn }) {
  if (typeof executable !== 'string' || !executable || !Array.isArray(args) || args.some(a => typeof a !== 'string')) {
    throw executionError('ERR_INVALID_PROCESS_ARGUMENT', '可执行路径与参数数组无效', { isSystemFailure: true, spawnNotStarted: true });
  }
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1 || maxBufferBytes > 64 * 1024 * 1024) {
    throw executionError('ERR_INVALID_BUFFER_LIMIT', '输出上限必须为 1 字节到 64MB 的整数', { isSystemFailure: true, spawnNotStarted: true });
  }
  if (stdinContent !== undefined && typeof stdinContent !== 'string' && !Buffer.isBuffer(stdinContent)) {
    throw executionError('ERR_INVALID_STDIN', 'stdinContent 必须为字符串或 Buffer', { isSystemFailure: true, spawnNotStarted: true });
  }
  if (process.platform === 'win32') {
    throw executionError('ERR_PROCESS_GROUP_UNSUPPORTED', '当前实现仅支持可核验 POSIX 进程组的平台', { isSystemFailure: true, spawnNotStarted: true });
  }
  const timeout = createTimeout(timeoutMs);

  return new Promise((resolve, reject) => {
    let child;
    let pgid = null;
    let closed = false;
    let leaderExited = false;
    let groupGone = false;
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    let stopping = false;
    let firstReason = null;
    let cancelled = false;
    let internalError = null;
    let forceKillTimer = null;
    let confirmTimer = null;
    let pollTimer = null;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    const cleanup = () => {
      timeout.close();
      clearTimeout(forceKillTimer);
      clearTimeout(confirmTimer);
      clearInterval(pollTimer);
      timeout.signal.removeEventListener('abort', onTimeout);
      process.removeListener('SIGINT', onParentSignal);
      process.removeListener('SIGTERM', onParentSignal);
    };

    const signalGroup = signal => {
      if (!pgid || groupGone) return;
      try { process.kill(-pgid, signal); }
      catch (err) {
        // The group may not yet be established immediately after spawn.
        if (err.code === 'ESRCH' && child && child.exitCode === null && child.signalCode === null) {
          try { child.kill(signal); } catch {}
        }
      }
    };

    const rejectUnconfirmed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      child?.stdin?.destroy();
      child?.unref();
      reject(executionError('ERR_PROCESS_GROUP_UNCONFIRMED', '无法确认本次子进程组完全退出；已保留任务追踪与锁，请显式核实恢复', {
        isSystemFailure: true, isCancelled: cancelled, processGroupUnconfirmed: true,
        childPid: child?.pid ?? null, pgid, terminationReason: firstReason
      }));
    };

    const settleConfirmed = () => {
      if (settled || !closed || (pgid && !groupGone && processGroupLiveness(pgid) !== 'DEAD')) return;
      settled = true;
      cleanup();
      const fields = { childPid: child?.pid ?? null, pgid, processGroupExited: true };
      if (cancelled) return reject(executionError('ERR_CANCELLED', '操作已取消，子进程组已确认退出', { ...fields, isCancelled: true, isSystemFailure: true }));
      if (firstReason === 'TIMEOUT') return reject(executionError('ERR_TIMEOUT', '子进程执行超时，进程组已确认退出', { ...fields, isSystemFailure: true }));
      if (firstReason === 'OVERFLOW') return reject(executionError('ERR_BUFFER_OVERFLOW', '子进程输出超过上限，进程组已确认退出', { ...fields, isSystemFailure: true }));
      if (firstReason === 'TRACKING') return reject(executionError('ERR_SPAWN_TRACKING', '子进程追踪登记失败，进程组已确认退出', { ...fields, isSystemFailure: true }));
      if (internalError) return reject(executionError(child?.pid ? 'ERR_CHILD_RUNTIME' : 'ERR_SPAWN_FAILED', '子进程启动或运行失败', { ...fields, isSystemFailure: true, spawnNotStarted: !child?.pid }));
      if (exitCode !== 0) return reject(executionError('ERR_PROCESS_EXIT_NON_ZERO', `子进程未成功退出（退出码 ${exitCode}，信号 ${exitSignal || '无'}）`, { ...fields, exitCode, signal: exitSignal }));
      resolve({ stdout, stderr, code: exitCode, ...fields, cleanedDescendants: firstReason === 'DESCENDANTS' });
    };

    const checkCompletion = () => {
      if (settled) return;
      if (!pgid && closed) { settleConfirmed(); return; }
      const groupState = processGroupLiveness(pgid);
      if (leaderExited && groupState === 'DEAD') groupGone = true;
      if (closed && (groupGone || groupState === 'DEAD')) { settleConfirmed(); return; }
      if (closed && !stopping) beginTermination('DESCENDANTS');
    };

    const beginTermination = reason => {
      if (settled || stopping) return;
      stopping = true;
      firstReason = reason;
      signalGroup('SIGTERM');
      forceKillTimer = setTimeout(() => {
        signalGroup('SIGKILL');
        checkCompletion();
      }, TERM_GRACE_MS);
      confirmTimer = setTimeout(() => {
        checkCompletion();
        if (!settled) rejectUnconfirmed();
      }, TERM_GRACE_MS + KILL_CONFIRM_MS);
      pollTimer = setInterval(checkCompletion, 100);
      checkCompletion();
    };

    function onParentSignal() { cancelled = true; beginTermination('CANCELLED'); }
    function onTimeout() { beginTermination('TIMEOUT'); }
    process.on('SIGINT', onParentSignal);
    process.on('SIGTERM', onParentSignal);
    timeout.signal.addEventListener('abort', onTimeout);

    try {
      child = spawn(executable, args, { cwd, shell: false, env: env || process.env,
        stdio: [stdinContent === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
      pgid = child.pid || null;
    } catch (err) {
      internalError = err;
      closed = true;
      settleConfirmed();
      return;
    }

    child.stdout?.on('data', chunk => {
      if (settled || stopping) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBufferBytes) { beginTermination('OVERFLOW'); return; }
      stdout += outDecoder.write(chunk);
    });
    child.stderr?.on('data', chunk => {
      if (settled || stopping) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxBufferBytes) { beginTermination('OVERFLOW'); return; }
      stderr = (stderr + errDecoder.write(chunk)).slice(-32768);
    });
    child.on('error', err => {
      if (settled) return;
      internalError = err;
      if (!child.pid) { closed = true; settleConfirmed(); }
      else beginTermination('CHILD_ERROR');
    });
    child.on('exit', () => { leaderExited = true; });
    child.on('close', (code, signal) => {
      if (settled) return;
      closed = true;
      exitCode = code;
      exitSignal = signal;
      if (!stopping) {
        stdout += outDecoder.end();
        stderr = (stderr + errDecoder.end()).slice(-32768);
      }
      checkCompletion();
    });

    if (child.pid && onSpawn) {
      try {
        const returned = onSpawn(child.pid, pgid);
        if (returned?.then) {
          Promise.resolve(returned).catch(() => {});
          throw new Error('onSpawn 必须同步持久化进程元数据');
        }
      } catch (err) {
        internalError = err;
        beginTermination('TRACKING');
      }
    }
    if (child.stdin) {
      child.stdin.on('error', err => {
        if (!settled && !stopping) { internalError = err; beginTermination('STDIN_ERROR'); }
      });
      if (!stopping) child.stdin.end(stdinContent);
      else child.stdin.end();
    }
  });
}

export function failClosed(reason, metadata = {}) {
  return { ...metadata, status: 'BLOCKED', reason: String(reason), requiresHuman: true, at: new Date().toISOString() };
}

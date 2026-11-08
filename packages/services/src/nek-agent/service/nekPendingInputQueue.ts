import { NEK_PENDING_INPUT_CANCELLED } from "@zcode/shared/nek-protocol";
import type { NekSessionRecord } from "./types.js";

/**
 * GUI 待发送输入（压缩期间的 pre-submit 暂存）队列——GUI 侧唯一 owner。
 *
 * nek 只在压缩收口后才接纳输入：压缩中发 `prompt` / `steer` / `follow_up` 会被拒绝，
 * 或者打乱压缩本身。因此压缩进行中由 GUI 持有"待发送"事实，把整段发送挂起，
 * 压缩收口后再按提交顺序走正常发送入口；只有发送命令真正返回（CLI 接纳）才移交
 * ownership。这不是 CLI 已接纳队列的镜像：CLI 侧没有任何排队事实。
 *
 * 不变量：
 * - 作用域 = 会话键 + sessionId；会话换代（fork / 重新绑定）后旧输入不会被回填；
 * - 有界：每条会话最多 {@link NekPendingInputQueueOptions.maxPerSession} 条，
 *   每条最多等 {@link NekPendingInputQueueOptions.timeoutMs}；
 * - 撤回（取消 / 超时 / 断线 / 关闭）都是可见失败，绝不静默丢弃，也不会在之后补发。
 */

interface NekPendingInputScope {
  sessionKey: string;
  sessionId: string;
}

interface NekPendingInputQueueOptions {
  /** 单会话上限；超过即拒绝，避免压缩长期不结束时内存无界增长。 */
  maxPerSession: number;
  /** 单条等待上限；到点可见失败，而不是让发送 Promise 永久悬挂。 */
  timeoutMs: number;
}

/** 待发送输入被撤回：界面据此恢复草稿并提示，不把压缩本身当成发送错误。 */
export class NekPendingInputCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = NEK_PENDING_INPUT_CANCELLED;
  }
}

interface NekPendingInputEntry {
  scope: NekPendingInputScope;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class NekPendingInputQueue {
  private readonly queues = new Map<string, NekPendingInputEntry[]>();
  private readonly draining = new Set<string>();
  private readonly options: NekPendingInputQueueOptions;

  constructor(options: NekPendingInputQueueOptions) {
    this.options = options;
  }

  /** 该会话仍在等待的条数（诊断与测试用）。 */
  pendingCount(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length ?? 0;
  }

  /** 是否正在按序收口：收口期间新到的发送要直接执行，不能二次排队自锁。 */
  isDraining(sessionKey: string): boolean {
    return this.draining.has(sessionKey);
  }

  /** 暂存一次发送；返回的 Promise 在真正提交（或可见失败）后结算。 */
  enqueue<T>(scope: NekPendingInputScope, run: () => Promise<T>): Promise<T> {
    const entries = this.queues.get(scope.sessionKey) ?? [];
    if (entries.length >= this.options.maxPerSession) {
      return Promise.reject(
        new NekPendingInputCancelledError("等待压缩完成的消息过多，本条没有发送；草稿已保留"),
      );
    }
    this.queues.set(scope.sessionKey, entries);
    return new Promise<T>((resolve, reject) => {
      const entry: NekPendingInputEntry = {
        scope: { ...scope },
        run,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          this.fail(
            entry,
            new NekPendingInputCancelledError("等待压缩完成超时，本条消息没有发送；草稿已保留"),
          );
        }, this.options.timeoutMs),
        settled: false,
      };
      // 不因为一条待发送输入而拖住进程退出。
      (entry.timer as { unref?: () => void }).unref?.();
      entries.push(entry);
    });
  }

  /**
   * 压缩收口：按提交顺序提交。
   *
   * 作用域已换代（sessionId 变化）的条目直接可见失败，绝不把旧会话的输入补发到新会话。
   */
  async drain(scope: NekPendingInputScope): Promise<void> {
    const entries = this.queues.get(scope.sessionKey);
    if (!entries || entries.length === 0 || this.draining.has(scope.sessionKey)) return;
    this.draining.add(scope.sessionKey);
    try {
      let next = entries[0];
      while (next) {
        entries.shift();
        if (!next.settled) await this.runEntry(next, scope);
        next = entries[0];
      }
    } finally {
      this.draining.delete(scope.sessionKey);
      // 收口期间可能已经为新队列重新入队：只清理自己那一份。
      if (this.queues.get(scope.sessionKey) === entries && entries.length === 0)
        this.queues.delete(scope.sessionKey);
    }
  }

  /** 会话关闭 / 断线 / 停止：全部可见失败，界面恢复草稿。 */
  cancel(sessionKey: string, reason: Error): void {
    const entries = this.queues.get(sessionKey);
    if (!entries) return;
    this.queues.delete(sessionKey);
    for (const entry of entries) this.fail(entry, reason);
  }

  cancelAll(reason: Error): void {
    for (const sessionKey of this.queues.keys()) this.cancel(sessionKey, reason);
  }

  private async runEntry(entry: NekPendingInputEntry, scope: NekPendingInputScope): Promise<void> {
    if (entry.scope.sessionId !== scope.sessionId) {
      this.fail(
        entry,
        new NekPendingInputCancelledError("会话已切换，待发送消息没有提交；草稿已保留"),
      );
      return;
    }
    try {
      this.succeed(entry, await entry.run());
    } catch (error) {
      this.fail(entry, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private succeed(entry: NekPendingInputEntry, value: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.resolve(value);
  }

  private fail(entry: NekPendingInputEntry, error: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    entry.reject(error);
  }
}

/** 控制器依赖：等待期间要持有进程租约，否则压缩进程会被空闲回收摘掉。 */
interface NekPendingInputControllerOptions {
  maxPerSession: number;
  timeoutMs: number;
  withLease: <T>(record: NekSessionRecord, run: () => Promise<T>) => Promise<T>;
  logger?: { warn: (...args: unknown[]) => void };
}

/**
 * 压缩期输入接纳的收口层：把"会话是否在压缩"和暂存队列绑在一起。
 *
 * 状态事实只有一处：CLI 的 `get_state.isCompacting` / 压缩事件，加上 compact 命令在
 * 首个 await 之前的预约。压缩中一律暂存，压缩收口后按序提交；压缩取消、断线、关闭
 * 或超时都是可见失败，界面恢复草稿。
 */
export class NekPendingInputController {
  private readonly queue: NekPendingInputQueue;
  private readonly options: NekPendingInputControllerOptions;

  constructor(options: NekPendingInputControllerOptions) {
    this.options = options;
    this.queue = new NekPendingInputQueue({
      maxPerSession: options.maxPerSession,
      timeoutMs: options.timeoutMs,
    });
  }

  /** 会话是否在压缩（含 GUI 预约）。 */
  isCompacting(record: NekSessionRecord): boolean {
    return record.compactReserved === true || record.state?.isCompacting === true;
  }

  pendingCount(sessionKey: string): number {
    return this.queue.pendingCount(sessionKey);
  }

  /** 压缩中挂起这次发送，压缩收口后按序提交；否则立即执行。 */
  async defer<T>(record: NekSessionRecord, run: () => Promise<T>): Promise<T> {
    if (!this.isCompacting(record)) return await run();
    if (this.queue.isDraining(record.key)) return await run();
    return await this.options.withLease(record, async () => {
      // 取租约是异步的：期间压缩可能已经收口（事件已处理完），此时直接按正常入口发送，
      // 不能入队等一个不会再来第二次的 compaction_end。
      if (!this.isCompacting(record) || this.queue.isDraining(record.key)) return await run();
      return (await this.queue.enqueue(this.scopeOf(record), run)) as T;
    });
  }

  /** 压缩收口：把暂存的输入按提交顺序交给正常发送入口。 */
  settle(record: NekSessionRecord): void {
    if (this.isCompacting(record) || this.queue.pendingCount(record.key) === 0) return;
    void this.queue.drain(this.scopeOf(record)).catch((error: unknown) => {
      this.options.logger?.warn("nek pending input drain failed", error);
    });
  }

  /** 撤回该会话的待发送输入：可见失败，绝不迟到重发。 */
  cancel(record: NekSessionRecord, reason: Error): void {
    this.queue.cancel(record.key, reason);
  }

  cancelAll(reason: Error): void {
    this.queue.cancelAll(reason);
  }

  private scopeOf(record: NekSessionRecord): NekPendingInputScope {
    return { sessionKey: record.key, sessionId: record.sessionId };
  }
}

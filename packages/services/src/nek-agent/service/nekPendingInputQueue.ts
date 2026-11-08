import { NEK_PENDING_INPUT_CANCELLED } from "@zcode/shared/nek-protocol";
import type { NekSessionRecord } from "./types.js";

/**
 * GUI 待发送输入（压缩期间的 pre-submit 暂存）队列——GUI 侧唯一 owner。
 *
 * nek 只在压缩收口后才接纳输入：压缩中发 `prompt` / `steer` / `follow_up` 会被拒绝，
 * 或者打乱压缩本身。因此压缩进行中由 GUI 持有"待发送"事实，压缩收口后再按提交顺序
 * 走正常发送入口；只有发送命令真正返回（CLI 接纳）才移交 ownership。这不是 CLI 已
 * 接纳队列的镜像：CLI 侧没有任何排队事实。
 *
 * 不变量：
 * - 作用域 = 会话键 + sessionId；会话换代（fork / 重新绑定）后旧输入不会被回填；
 * - 有界：每条会话最多 `maxPerSession` 条，每条最多等 `timeoutMs`；
 * - **等待计时只覆盖"还没开始提交"的阶段**：`submit()` 一开始就解除计时器，之后由真实
 *   RPC 结果裁决。否则晚到的 ACK 会被超时伪称"没有发送"，用户重试就重复发了；
 * - 撤回（取消 / 超时 / 断线 / 关闭）都是可见失败，绝不静默丢弃，也不会在之后补发。
 */

interface NekPendingInputScope {
  sessionKey: string;
  sessionId: string;
}

interface NekPendingInputQueueOptions {
  /** 单会话上限；超过即拒绝，避免压缩长期不结束时内存无界增长。 */
  maxPerSession: number;
  /** 单条等待上限（只算排队阶段）；到点可见失败，而不是让发送 Promise 永久悬挂。 */
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
  timer: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

/** 队首条目：交给收口循环提交；提交之后不再接受"待发超时"这类撤回。 */
interface NekPendingInputJob {
  /** 入队时的会话身份；换代后旧输入不得补发到新会话。 */
  readonly sessionId: string;
  /** 提交并结算。进入提交即解除等待计时器，结果由真实 RPC 决定。 */
  submit(): Promise<void>;
  /** 提交前撤回：可见失败。 */
  cancel(reason: Error): void;
}

class NekPendingInputQueue {
  private readonly queues = new Map<string, NekPendingInputEntry[]>();
  private readonly options: NekPendingInputQueueOptions;

  constructor(options: NekPendingInputQueueOptions) {
    this.options = options;
  }

  /** 该会话仍在排队的条数（不含已进入提交的那一条）。 */
  count(sessionKey: string): number {
    return this.queues.get(sessionKey)?.length ?? 0;
  }

  /** 排进队尾；返回的 Promise 在真正提交（或可见失败）后结算。 */
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
        timer: undefined,
        settled: false,
      };
      entry.timer = setTimeout(() => {
        this.fail(
          entry,
          new NekPendingInputCancelledError("等待压缩完成超时，本条消息没有发送；草稿已保留"),
        );
      }, this.options.timeoutMs);
      // 不因为一条待发送输入而拖住进程退出。
      (entry.timer as { unref?: () => void }).unref?.();
      entries.push(entry);
    });
  }

  /** 取队首交给收口循环；队列为空返回 `undefined`。 */
  take(sessionKey: string): NekPendingInputJob | undefined {
    const entries = this.queues.get(sessionKey);
    const entry = entries?.shift();
    if (!entries || entries.length === 0) this.queues.delete(sessionKey);
    if (!entry) return undefined;
    return {
      sessionId: entry.scope.sessionId,
      submit: async () => {
        // 计时器在提交开始那一刻解除：之后只能由真实 RPC 结果裁决。
        this.disarm(entry);
        try {
          this.succeed(entry, await entry.run());
        } catch (error) {
          this.fail(entry, error instanceof Error ? error : new Error(String(error)));
        }
      },
      cancel: (reason: Error) => this.fail(entry, reason),
    };
  }

  /** 会话关闭 / 断线 / 停止：尚未提交的条目全部可见失败，界面恢复草稿。 */
  cancel(sessionKey: string, reason: Error): void {
    const entries = this.queues.get(sessionKey);
    if (!entries) return;
    this.queues.delete(sessionKey);
    for (const entry of entries) this.fail(entry, reason);
  }

  cancelAll(reason: Error): void {
    for (const sessionKey of this.queues.keys()) this.cancel(sessionKey, reason);
  }

  private disarm(entry: NekPendingInputEntry): void {
    if (entry.timer === undefined) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  private succeed(entry: NekPendingInputEntry, value: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    this.disarm(entry);
    this.removeFromQueue(entry);
    entry.resolve(value);
  }

  private fail(entry: NekPendingInputEntry, error: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    this.disarm(entry);
    // 已超时/撤回的条目不能再留在队列里被下一次收口取出来执行。
    this.removeFromQueue(entry);
    entry.reject(error);
  }

  private removeFromQueue(entry: NekPendingInputEntry): void {
    const entries = this.queues.get(entry.scope.sessionKey);
    if (!entries) return;
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (entries.length === 0) this.queues.delete(entry.scope.sessionKey);
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
 * 首个 await 之前的预约。压缩中一律暂存，压缩收口后按提交顺序提交；压缩取消、断线、
 * 关闭或排队超时都是可见失败，界面恢复草稿。
 *
 * 收口只按队首推进，任何新输入都排到队尾：没有"同会话请求一律放行"的旁路，
 * 否则新输入会越过还没发完的旧条目。收口过程中如果又进入压缩，剩余条目原地暂停，
 * 等下一次收口（不会重复提交）。
 */
export class NekPendingInputController {
  private readonly queue: NekPendingInputQueue;
  private readonly options: NekPendingInputControllerOptions;
  private readonly draining = new Set<string>();

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

  /** 仍在排队（尚未进入提交）的条数。 */
  pendingCount(sessionKey: string): number {
    return this.queue.count(sessionKey);
  }

  /**
   * 压缩中挂起这次发送，压缩收口后按序提交；否则立即执行。
   *
   * `run` 收到 `queued`：这次发送是否真的经过了 GUI 待发队列。排队过的输入在提交时
   * 可能已经有新一轮在跑（前一条待发输入起了回合），调用方据此选择默认投递方式。
   */
  async defer<T>(record: NekSessionRecord, run: (queued: boolean) => Promise<T>): Promise<T> {
    if (this.canSubmitNow(record)) return await run(false);
    return await this.options.withLease(record, async () => {
      // 取租约是异步的：期间压缩可能已经收口、队列也可能已被排空。
      if (this.canSubmitNow(record)) return await run(false);
      const pending = this.queue.enqueue(this.scopeOf(record), () => run(true)) as Promise<T>;
      // 入队瞬间压缩恰好收口时立即收口；drain 自带重入保护。
      this.drainIfPossible(record);
      return await pending;
    });
  }

  /** 压缩收口：把暂存的输入按提交顺序交给正常发送入口。 */
  settle(record: NekSessionRecord): void {
    this.drainIfPossible(record);
  }

  /** 撤回该会话的待发送输入：可见失败，绝不迟到重发。已在提交的条目不受影响。 */
  cancel(record: NekSessionRecord, reason: Error): void {
    this.queue.cancel(record.key, reason);
  }

  cancelAll(reason: Error): void {
    this.queue.cancelAll(reason);
  }

  private canSubmitNow(record: NekSessionRecord): boolean {
    return (
      !this.isCompacting(record) &&
      !this.draining.has(record.key) &&
      this.queue.count(record.key) === 0
    );
  }

  private drainIfPossible(record: NekSessionRecord): void {
    if (this.isCompacting(record)) return;
    if (this.draining.has(record.key)) return;
    if (this.queue.count(record.key) === 0) return;
    void this.drain(record).catch((error: unknown) => {
      this.options.logger?.warn("nek pending input drain failed", error);
    });
  }

  private async drain(record: NekSessionRecord): Promise<void> {
    this.draining.add(record.key);
    try {
      for (;;) {
        // 收口期间又进入压缩：剩余条目原地暂停，等下一次收口，顺序不变也不重复。
        if (this.isCompacting(record)) return;
        const job = this.queue.take(record.key);
        if (!job) return;
        if (job.sessionId !== record.sessionId) {
          job.cancel(
            new NekPendingInputCancelledError("会话已切换，待发送消息没有提交；草稿已保留"),
          );
          continue;
        }
        await job.submit();
      }
    } finally {
      this.draining.delete(record.key);
    }
  }

  private scopeOf(record: NekSessionRecord): NekPendingInputScope {
    return { sessionKey: record.key, sessionId: record.sessionId };
  }
}

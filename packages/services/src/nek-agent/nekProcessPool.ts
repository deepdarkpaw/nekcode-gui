/**
 * nek 进程池：会话进程按会话键管理，控制进程每台机器一个。
 *
 * 规则（ARD §1、计划 §4）：
 * - 每个打开的会话一个 `nek --mode rpc` 进程，默认上限 8 个；
 * - 空闲 10 分钟回收；正在跑回合的进程不回收；
 * - 同一个会话键只允许一个进程（再次 acquire 复用同一个句柄）；
 * - 控制进程（`--mode rpc --control`）懒启动，崩溃后退避重启。
 *
 * 本模块不 spawn 任何东西：进程创建由注入的工厂完成，因此可以直接用测试替身驱动。
 */

export interface NekPooledProcess {
  /** 关闭客户端并回收整棵进程树。 */
  dispose: () => void | Promise<void>;
  /** 订阅进程退出（含崩溃）；返回取消订阅。 */
  onExit?: (listener: () => void) => () => void;
  readonly pid?: number;
}

export type NekProcessPoolEvent =
  | { type: "session_created"; sessionKey: string; activeSessions: number }
  | { type: "session_reused"; sessionKey: string }
  | {
      type: "session_reclaimed";
      sessionKey: string;
      reason: "idle" | "capacity" | "dispose" | "crashed";
    }
  | { type: "session_capacity_exceeded"; sessionKey: string; maxSessions: number }
  | { type: "control_started" }
  | { type: "control_stopped"; reason: "exited" | "dispose" }
  | { type: "control_restart_scheduled"; attempt: number; delayMs: number }
  | { type: "pool_disposed" };

export class NekProcessPoolCapacityError extends Error {
  constructor(
    readonly sessionKey: string,
    readonly maxSessions: number,
  ) {
    super(`nek process pool is full (${maxSessions} sessions) and no session is idle to reclaim`);
    this.name = "NekProcessPoolCapacityError";
  }
}

export class NekProcessPoolDisposedError extends Error {
  constructor() {
    super("nek process pool has been disposed");
    this.name = "NekProcessPoolDisposedError";
  }
}

export interface NekProcessPoolLogger {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface NekControlRestartBackoff {
  initialMs: number;
  maxMs: number;
}

export interface NekProcessPoolOptions<H extends NekPooledProcess> {
  createSessionProcess: (sessionKey: string) => Promise<H>;
  createControlProcess?: () => Promise<H>;
  /** 会话进程上限，默认 8。 */
  maxSessions?: number;
  /** 空闲回收阈值，默认 10 分钟。 */
  idleTimeoutMs?: number;
  /** 控制进程重启退避，默认 1 s 起、每次翻倍、封顶 30 s。 */
  controlRestartBackoff?: NekControlRestartBackoff;
  /** 时钟注入（测试用）。 */
  now?: () => number;
  /** 定时器注入（测试用）。默认每 `min(idleTimeoutMs / 2, 60 s)` 扫一次。 */
  scheduleInterval?: (fn: () => void, intervalMs: number) => () => void;
  logger?: NekProcessPoolLogger;
}

interface SessionEntry<H extends NekPooledProcess> {
  sessionKey: string;
  handle: H;
  /** 仍持有该会话的调用方数量（打开中的会话）。 */
  refCount: number;
  /** 正在跑的回合数；> 0 时不回收。 */
  busyCount: number;
  lastUsedAt: number;
  detachExit?: () => void;
}

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_CONTROL_BACKOFF: NekControlRestartBackoff = { initialMs: 1_000, maxMs: 30_000 };
const MAX_SWEEP_INTERVAL_MS = 60_000;

function defaultScheduleInterval(fn: () => void, intervalMs: number): () => void {
  const timer = setInterval(fn, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export class NekProcessPool<H extends NekPooledProcess = NekPooledProcess> {
  private readonly sessions = new Map<string, SessionEntry<H>>();
  private readonly listeners = new Set<(event: NekProcessPoolEvent) => void>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly controlBackoff: NekControlRestartBackoff;
  private readonly now: () => number;
  private controlHandle: H | undefined;
  private controlStarting: Promise<H> | undefined;
  private controlDetachExit: (() => void) | undefined;
  private controlRestartAttempt = 0;
  private controlRestartTimer: ReturnType<typeof setTimeout> | undefined;
  private stopSweep: (() => void) | undefined;
  private disposed = false;

  constructor(private readonly options: NekProcessPoolOptions<H>) {
    this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    this.controlBackoff = options.controlRestartBackoff ?? DEFAULT_CONTROL_BACKOFF;
    this.now = options.now ?? Date.now;
    const scheduleInterval = options.scheduleInterval ?? defaultScheduleInterval;
    this.stopSweep = scheduleInterval(
      () => {
        void this.sweep();
      },
      Math.min(Math.floor(this.idleTimeoutMs / 2) || 1, MAX_SWEEP_INTERVAL_MS),
    );
  }

  // --------------------------------------------------------------------------
  // 订阅与诊断
  // --------------------------------------------------------------------------

  onEvent(listener: (event: NekProcessPoolEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): {
    sessions: Array<{ sessionKey: string; refCount: number; busyCount: number; idleMs: number }>;
    controlActive: boolean;
  } {
    const now = this.now();
    return {
      sessions: [...this.sessions.values()].map((entry) => ({
        sessionKey: entry.sessionKey,
        refCount: entry.refCount,
        busyCount: entry.busyCount,
        idleMs: Math.max(0, now - entry.lastUsedAt),
      })),
      controlActive: this.controlHandle !== undefined,
    };
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  // --------------------------------------------------------------------------
  // 会话进程
  // --------------------------------------------------------------------------

  /** 取（或创建）某个会话的进程。同一会话键永远返回同一个句柄。 */
  async acquireSession(sessionKey: string): Promise<H> {
    this.assertAlive();
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.refCount += 1;
      existing.lastUsedAt = this.now();
      this.emit({ type: "session_reused", sessionKey });
      return existing.handle;
    }
    await this.makeRoomFor(sessionKey);
    const handle = await this.options.createSessionProcess(sessionKey);
    if (this.disposed) {
      await handle.dispose();
      throw new NekProcessPoolDisposedError();
    }
    const entry: SessionEntry<H> = {
      sessionKey,
      handle,
      refCount: 1,
      busyCount: 0,
      lastUsedAt: this.now(),
    };
    entry.detachExit = handle.onExit?.(() => this.handleSessionExit(sessionKey, entry));
    this.sessions.set(sessionKey, entry);
    this.emit({ type: "session_created", sessionKey, activeSessions: this.sessions.size });
    return handle;
  }

  /** 已存在的会话进程（不创建）。 */
  getSession(sessionKey: string): H | undefined {
    return this.sessions.get(sessionKey)?.handle;
  }

  /** 释放一次持有；引用归零后进入空闲计时，到点由 `sweep()` 回收。 */
  releaseSession(sessionKey: string): void {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastUsedAt = this.now();
  }

  /** 标记一个回合开始。回合进行中的进程不会被空闲或容量回收。 */
  beginTurn(sessionKey: string): void {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    entry.busyCount += 1;
    entry.lastUsedAt = this.now();
  }

  /** 标记一个回合结束（`agent_settled` / 出错 / 中止都要调到）。 */
  endTurn(sessionKey: string): void {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    entry.busyCount = Math.max(0, entry.busyCount - 1);
    entry.lastUsedAt = this.now();
  }

  /** 显式回收某个会话进程（关会话、会话被外部占用等）。 */
  async reclaimSession(
    sessionKey: string,
    reason: "idle" | "capacity" | "dispose" | "crashed" = "idle",
  ): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    this.sessions.delete(sessionKey);
    entry.detachExit?.();
    this.emit({ type: "session_reclaimed", sessionKey, reason });
    await entry.handle.dispose();
  }

  /** 回收所有空闲且没有回合在跑的会话进程。 */
  async sweep(): Promise<void> {
    if (this.disposed) return;
    const now = this.now();
    const idleKeys = [...this.sessions.values()]
      .filter(
        (entry) =>
          entry.refCount === 0 &&
          entry.busyCount === 0 &&
          now - entry.lastUsedAt >= this.idleTimeoutMs,
      )
      .map((entry) => entry.sessionKey);
    for (const key of idleKeys) {
      this.options.logger?.debug?.("reclaiming idle nek session process", key);
      await this.reclaimSession(key, "idle");
    }
  }

  // --------------------------------------------------------------------------
  // 控制进程
  // --------------------------------------------------------------------------

  /** 当前控制进程（未启动或正在重启时为 undefined）。 */
  get control(): H | undefined {
    return this.controlHandle;
  }

  /** 懒启动控制进程；并发调用共享同一次启动。 */
  async ensureControl(): Promise<H> {
    this.assertAlive();
    if (this.controlHandle) return this.controlHandle;
    const factory = this.options.createControlProcess;
    if (!factory) throw new Error("control process factory is not configured");
    this.controlStarting ??= factory()
      .then((handle) => {
        if (this.disposed) {
          void handle.dispose();
          throw new NekProcessPoolDisposedError();
        }
        this.controlHandle = handle;
        this.controlRestartAttempt = 0;
        this.controlDetachExit = handle.onExit?.(() => this.handleControlExit());
        this.emit({ type: "control_started" });
        return handle;
      })
      .finally(() => {
        this.controlStarting = undefined;
      });
    return await this.controlStarting;
  }

  /** 主动重建控制进程（`reload` 后配置失效、或用户点"重启"）。 */
  async restartControl(): Promise<H> {
    this.assertAlive();
    this.clearControlRestartTimer();
    await this.disposeControl("exited");
    return await this.ensureControl();
  }

  // --------------------------------------------------------------------------
  // 生命周期
  // --------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSweep?.();
    this.stopSweep = undefined;
    this.clearControlRestartTimer();
    const handles = [...this.sessions.values()].map((entry) => {
      entry.detachExit?.();
      return entry.handle;
    });
    this.sessions.clear();
    this.emit({ type: "pool_disposed" });
    await Promise.all(handles.map(async (handle) => await handle.dispose()));
    await this.disposeControl("dispose");
    this.listeners.clear();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private assertAlive(): void {
    if (this.disposed) throw new NekProcessPoolDisposedError();
  }

  /** 腾出一个位置：优先回收最久未用的空闲会话；全忙则报容量不足。 */
  private async makeRoomFor(sessionKey: string): Promise<void> {
    if (this.sessions.size < this.maxSessions) return;
    const idle = [...this.sessions.values()]
      .filter((entry) => entry.refCount === 0 && entry.busyCount === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!idle) {
      this.emit({ type: "session_capacity_exceeded", sessionKey, maxSessions: this.maxSessions });
      throw new NekProcessPoolCapacityError(sessionKey, this.maxSessions);
    }
    await this.reclaimSession(idle.sessionKey, "capacity");
  }

  private handleSessionExit(sessionKey: string, entry: SessionEntry<H>): void {
    if (this.sessions.get(sessionKey) !== entry) return;
    this.sessions.delete(sessionKey);
    entry.detachExit?.();
    this.emit({ type: "session_reclaimed", sessionKey, reason: "crashed" });
    // 进程已经不在，不再调用 dispose（否则会重复杀一遍）。
  }

  private handleControlExit(): void {
    if (!this.controlHandle) return;
    this.controlDetachExit?.();
    this.controlDetachExit = undefined;
    this.controlHandle = undefined;
    this.emit({ type: "control_stopped", reason: "exited" });
    if (this.disposed) return;
    this.scheduleControlRestart();
  }

  private scheduleControlRestart(): void {
    if (!this.options.createControlProcess) return;
    this.clearControlRestartTimer();
    this.controlRestartAttempt += 1;
    const delayMs = Math.min(
      this.controlBackoff.initialMs * 2 ** (this.controlRestartAttempt - 1),
      this.controlBackoff.maxMs,
    );
    this.emit({ type: "control_restart_scheduled", attempt: this.controlRestartAttempt, delayMs });
    this.controlRestartTimer = setTimeout(() => {
      this.controlRestartTimer = undefined;
      void this.ensureControl().catch((error) => {
        this.options.logger?.warn("failed to restart nek control process", error);
      });
    }, delayMs);
    this.controlRestartTimer.unref?.();
  }

  private clearControlRestartTimer(): void {
    if (!this.controlRestartTimer) return;
    clearTimeout(this.controlRestartTimer);
    this.controlRestartTimer = undefined;
  }

  private async disposeControl(reason: "exited" | "dispose"): Promise<void> {
    const handle = this.controlHandle;
    this.controlHandle = undefined;
    this.controlDetachExit?.();
    this.controlDetachExit = undefined;
    if (!handle) return;
    this.emit({ type: "control_stopped", reason });
    await handle.dispose();
  }

  private emit(event: NekProcessPoolEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.warn("nek process pool listener threw", error);
      }
    }
  }
}

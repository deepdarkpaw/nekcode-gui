export type RemoteReconnectState =
  | { kind: "connected" }
  | { kind: "disconnected"; error?: Error }
  | { kind: "reconnecting"; attempt: number; max: number; nextDelayMs: number }
  | { kind: "failed"; error: Error; attempts: number; max: number }
  | { kind: "cancelled" };

export interface ReconnectClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RemoteReconnectOptions {
  backoffSeconds: readonly number[];
  connect: () => Promise<void>;
  clock?: ReconnectClock;
  onStateChange?: (state: RemoteReconnectState) => void;
}

const systemClock: ReconnectClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 远程 SSH 的单一重连状态所有者。旧连接的迟到结果通过 generation 丢弃，
 * 手动 retry/cancel 不会被前一次 connect 的 Promise 覆盖。
 */
export class RemoteReconnectStateMachine {
  private readonly backoffMs: number[];
  private readonly maxAttempts: number;
  private readonly connect: () => Promise<void>;
  private readonly clock: ReconnectClock;
  private readonly listeners = new Set<(state: RemoteReconnectState) => void>();
  private timer: unknown;
  private generation = 0;
  private attempt = 0;
  private currentState: RemoteReconnectState = { kind: "connected" };

  constructor(options: RemoteReconnectOptions) {
    this.backoffMs = options.backoffSeconds.map((seconds) => Math.max(0, seconds) * 1000);
    if (this.backoffMs.length === 0) throw new Error("reconnectBackoffSeconds must not be empty");
    this.maxAttempts = this.backoffMs.length;
    this.connect = options.connect;
    this.clock = options.clock ?? systemClock;
    if (options.onStateChange) this.listeners.add(options.onStateChange);
  }

  get state(): RemoteReconnectState {
    return this.currentState;
  }

  onStateChange(listener: (state: RemoteReconnectState) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  markConnected(): void {
    this.cancelTimer();
    this.generation += 1;
    this.attempt = 0;
    this.setState({ kind: "connected" });
  }

  markDisconnected(error?: unknown): void {
    if (this.currentState.kind === "cancelled") return;
    this.cancelTimer();
    this.generation += 1;
    this.attempt = 0;
    this.setState({ kind: "disconnected", ...(error ? { error: asError(error) } : {}) });
    this.scheduleAttempt(this.generation, 1);
  }

  /** 用户点击立即重试；跳过当前退避但仍从 attempt=1 计数。 */
  retryNow(): void {
    if (this.currentState.kind === "cancelled") return;
    this.cancelTimer();
    this.generation += 1;
    this.attempt = 0;
    this.scheduleAttempt(this.generation, 1, 0);
  }

  cancel(): void {
    this.cancelTimer();
    this.generation += 1;
    this.setState({ kind: "cancelled" });
  }

  private setState(state: RemoteReconnectState): void {
    this.currentState = state;
    for (const listener of this.listeners) listener(state);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleAttempt(generation: number, attempt: number, delayOverrideMs?: number): void {
    if (generation !== this.generation || this.currentState.kind === "cancelled") return;
    this.attempt = attempt;
    const delayMs = delayOverrideMs ?? this.backoffMs[attempt - 1]!;
    this.setState({
      kind: "reconnecting",
      attempt,
      max: this.maxAttempts,
      nextDelayMs: delayMs,
    });
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.runAttempt(generation, attempt);
    }, delayMs);
  }

  private isCancelled(): boolean {
    return this.currentState.kind === "cancelled";
  }

  private async runAttempt(generation: number, attempt: number): Promise<void> {
    if (generation !== this.generation || this.isCancelled()) return;
    try {
      await this.connect();
      if (generation !== this.generation || this.isCancelled()) return;
      this.markConnected();
    } catch (error) {
      if (generation !== this.generation || this.isCancelled()) return;
      if (attempt >= this.maxAttempts) {
        this.setState({
          kind: "failed",
          error: asError(error),
          attempts: attempt,
          max: this.maxAttempts,
        });
        return;
      }
      this.scheduleAttempt(generation, attempt + 1);
    }
  }
}

import type { Readable, Writable } from "node:stream";
import type {
  NekAuthEventRecord,
  NekExtensionEvent,
  NekExtensionEvents,
  NekExtensionUiResponse,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcEvent,
  NekRpcEventOfType,
  NekRpcEventType,
  NekRpcResponseDataFor,
} from "@zcode/shared/nek-protocol";
import type { NekExtensionUiHandler } from "./nekExtensionUiRouter.js";
import { NekExtensionUiRouter } from "./nekExtensionUiRouter.js";
import { attachNekJsonlReader, serializeNekJsonLine } from "./jsonl.js";
import {
  NekRpcClosedError,
  NekRpcCommandError,
  NekRpcProcessExitedError,
  NekRpcTimeoutError,
  NekRpcWriteError,
} from "./nekRpcErrors.js";
import { attachNekStderrReader, NekStderrRingBuffer } from "./nekStderrRing.js";
import { resolveNekRpcTimeoutMs } from "./nekRpcTimeouts.js";

/**
 * nek `--mode rpc` 的 JSONL over stdio 客户端（与传输无关）。
 *
 * 只依赖一个句柄 `{ stdin, stdout, stderr, kill, onExit }`：本机 spawn、SSH exec 通道、
 * 测试替身都用同一个实现。职责：
 * - 按 `id` 关联 `response`（nek 的命令处理是并发的，不能按顺序配对）；
 * - 按命令类型设超时；
 * - 把 `extension_ui_request` 路由到注入的 handler，dialog/structured 等回复，
 *   fire-and-forget 只通知；`extension_ui_cancel` 关闭对应对话框；
 * - `auth_event` / `extension_event` 分发；
 * - stderr 进有界环形缓冲；
 * - 关闭：`stdin.end()` → 等最多 1.5 s → 强制回收进程树。
 */

/** 进程退出/启动失败的通知。 */
export interface NekRpcProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/** 传输无关的进程句柄。`kill` 由启动器提供（会回收整棵进程树）。 */
export interface NekRpcProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable | null;
  kill: () => void;
  /** 订阅退出；返回取消订阅。必须在构造 client 之前可用。 */
  onExit: (listener: (info: NekRpcProcessExit) => void) => () => void;
}

export type { NekExtensionUiHandler } from "./nekExtensionUiRouter.js";

export interface NekRpcClientLogger {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface NekRpcClientOptions {
  /** 命令 id 前缀，便于在同一台机器的日志里区分多个会话进程。 */
  requestIdPrefix?: string;
  /** 覆盖某个命令类型的超时。 */
  timeouts?: Readonly<Partial<Record<string, number>>>;
  defaultTimeoutMs?: number;
  /** 关闭时等待进程自行退出的时长，默认 1500 ms。 */
  closeGraceMs?: number;
  /** stdout 单行上限，默认 {@link NEK_JSONL_MAX_LINE_BYTES}。 */
  maxLineBytes?: number;
  extensionUi?: NekExtensionUiHandler;
  logger?: NekRpcClientLogger;
  /** 每读到一行 stderr 的回调（转日志用）；环形缓冲总是保留。 */
  onStderrLine?: (line: string) => void;
  stderrMaxLines?: number;
  stderrMaxBytes?: number;
}

export type NekRpcClientState = "open" | "closing" | "closed";

interface PendingCall {
  command: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_CLOSE_GRACE_MS = 1500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class NekRpcClient {
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Map<string, Set<(event: NekRpcEvent) => void>>();
  private readonly anyListeners = new Set<(event: NekRpcEvent) => void>();
  private readonly exitListeners = new Set<(info: NekRpcProcessExit) => void>();
  private readonly uiRouter: NekExtensionUiRouter;
  private readonly stderr: NekStderrRingBuffer;
  private readonly exitSubscription: () => void;
  private detachStdout: (() => void) | undefined;
  private detachStderr: (() => void) | undefined;
  private nextId = 1;
  private stateValue: NekRpcClientState = "open";
  private exitPromise: Promise<NekRpcProcessExit> | undefined;
  private resolveExit: ((info: NekRpcProcessExit) => void) | undefined;
  private exitInfo: NekRpcProcessExit | undefined;

  constructor(
    private readonly handle: NekRpcProcessHandle,
    private readonly options: NekRpcClientOptions = {},
  ) {
    this.stderr = new NekStderrRingBuffer({
      maxLines: options.stderrMaxLines,
      maxBytes: options.stderrMaxBytes,
    });
    this.uiRouter = new NekExtensionUiRouter({
      handler: options.extensionUi,
      respond: (response) => this.respondExtensionUi(response),
      logger: options.logger,
    });
    this.detachStdout = attachNekJsonlReader(
      handle.stdout,
      {
        onRecord: (record) => this.handleRecord(record),
        onParseError: (error, line) =>
          this.options.logger?.warn(
            `nek stdout line is not valid JSON: ${error.message}`,
            line.slice(0, 512),
          ),
        onLineTooLong: (error) => this.failProtocol(error),
      },
      { maxLineBytes: options.maxLineBytes },
    );
    if (handle.stderr) {
      this.detachStderr = attachNekStderrReader(handle.stderr, (line) => {
        this.stderr.push(line);
        this.options.onStderrLine?.(line);
      });
    }
    handle.stdout.on("error", (error) => this.failProtocol(error));
    this.exitSubscription = handle.onExit((info) => this.handleExit(info));
  }

  get state(): NekRpcClientState {
    return this.stateValue;
  }

  /** 尚未收到响应的请求数。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  // --------------------------------------------------------------------------
  // 命令
  // --------------------------------------------------------------------------

  /**
   * 发一条命令并等它的响应。
   *
   * 注意 `prompt` 的语义：resolve 表示 nek 已受理（见 `disposition`），不代表回合结束；
   * 回合推进要订阅 `agent_*` / `message_*` / `tool_execution_*` 事件。
   */
  async call<C extends NekRpcCommandType>(
    command: NekRpcCommandOfType<C>,
  ): Promise<NekRpcResponseDataFor<C>> {
    const id = typeof command.id === "string" && command.id !== "" ? command.id : this.allocateId();
    const payload = { ...command, id };
    return await new Promise<NekRpcResponseDataFor<C>>((resolve, reject) => {
      if (this.stateValue !== "open") {
        reject(new NekRpcClosedError(`nek RPC client is ${this.stateValue}`));
        return;
      }
      const timeoutMs = resolveNekRpcTimeoutMs(
        command.type,
        this.options.timeouts,
        this.options.defaultTimeoutMs,
      );
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NekRpcTimeoutError(command.type, timeoutMs, id));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        command: command.type,
        timer,
        resolve: (data) => resolve(data as NekRpcResponseDataFor<C>),
        reject,
      });
      try {
        this.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 只写不等的命令（`extension_ui_response` 没有响应记录）。 */
  send(command: Record<string, unknown> & { type: string }): void {
    if (this.stateValue !== "open")
      throw new NekRpcClosedError(`nek RPC client is ${this.stateValue}`);
    this.write(command);
  }

  /** 回扩展 UI 响应。 */
  respondExtensionUi(response: NekExtensionUiResponse): void {
    if (this.stateValue !== "open") return;
    this.write(response);
  }

  // --------------------------------------------------------------------------
  // 订阅
  // --------------------------------------------------------------------------

  /** 按 `type` 订阅事件（含扩展 UI 请求，便于观察）。返回退订函数。 */
  onEvent<T extends NekRpcEventType>(
    type: T,
    listener: (event: NekRpcEventOfType<T>) => void,
  ): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as (event: NekRpcEvent) => void);
    return () => {
      set?.delete(listener as (event: NekRpcEvent) => void);
    };
  }

  /** 订阅所有事件。 */
  onAnyEvent(listener: (event: NekRpcEvent) => void): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /** 按扩展事件名订阅，payload 按 `NekExtensionEvents` 收窄。 */
  onExtensionEventName<K extends keyof NekExtensionEvents>(
    name: K,
    listener: (payload: NekExtensionEvents[K], event: NekExtensionEvent) => void,
  ): () => void {
    return this.onEvent("extension_event", (event) => {
      if (event.name === name) listener(event.payload as NekExtensionEvents[K], event);
    });
  }

  /** 订阅 `auth_event`（登录期间 nek 透传的交互通知）。 */
  onAuthEvent(listener: (event: NekAuthEventRecord) => void): () => void {
    return this.onEvent("auth_event", listener);
  }

  /** 订阅进程退出（正常关闭也会触发；关闭流程里不重复通知）。 */
  onExit(listener: (info: NekRpcProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  /** stderr 尾部文本（错误摘要用）。 */
  stderrText(maxLines?: number): string {
    return this.stderr.text(maxLines);
  }

  // --------------------------------------------------------------------------
  // 关闭
  // --------------------------------------------------------------------------

  /**
   * 优雅关闭：`stdin.end()` → 最多等 `closeGraceMs` → 强制回收进程树。
   * 幂等；挂起请求以 {@link NekRpcClosedError} 结束。
   */
  async close(): Promise<void> {
    if (this.stateValue !== "open") return;
    this.stateValue = "closing";
    this.rejectAllPending(
      new NekRpcClosedError("nek RPC client closed before the response arrived"),
    );
    this.uiRouter.cancelAll();
    try {
      this.handle.stdin.end();
    } catch (error) {
      this.options.logger?.warn("failed to end nek stdin", error);
    }
    const exited = await this.waitForExit(this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
    if (!exited) {
      this.options.logger?.warn("nek process did not exit in time; killing the process tree");
      this.handle.kill();
      await this.waitForExit(this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS);
    }
    this.finalize(this.exitInfo ?? { code: null, signal: null });
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private allocateId(): string {
    const prefix = this.options.requestIdPrefix ? `${this.options.requestIdPrefix}-` : "";
    const id = `${prefix}${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private write(payload: unknown): void {
    const type = isRecord(payload) && typeof payload.type === "string" ? payload.type : "unknown";
    try {
      this.handle.stdin.write(serializeNekJsonLine(payload));
    } catch (error) {
      throw new NekRpcWriteError(type, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleRecord(record: unknown): void {
    if (!isRecord(record) || typeof record.type !== "string") {
      this.options.logger?.warn("nek stdout record without a type", record);
      return;
    }
    if (record.type === "response") {
      this.handleResponse(record);
      return;
    }
    const event = record as unknown as NekRpcEvent;
    if (event.type === "extension_ui_request") {
      this.uiRouter.handle(event);
    } else if (event.type === "extension_ui_cancel") {
      this.uiRouter.cancel(event.id);
    }
    this.dispatch(event);
  }

  private handleResponse(record: Record<string, unknown>): void {
    const id = typeof record.id === "string" ? record.id : undefined;
    if (id === undefined) {
      this.options.logger?.warn("nek response without id", record.command);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      // 超时后才到的响应：上行已经以超时结束，这里只记录，不再 resolve 两次。
      this.options.logger?.debug?.(`nek response for unknown request ${id}`, record.command);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (record.success === true) {
      pending.resolve(record.data);
      return;
    }
    const detail = typeof record.error === "string" ? record.error : "unknown error";
    pending.reject(new NekRpcCommandError(pending.command, detail, id));
  }

  private dispatch(event: NekRpcEvent): void {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const listener of Array.from(set)) {
        try {
          listener(event);
        } catch (error) {
          this.options.logger?.warn(`nek event listener for ${event.type} threw`, error);
        }
      }
    }
    for (const listener of Array.from(this.anyListeners)) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.warn("nek any-event listener threw", error);
      }
    }
  }

  private handleExit(info: NekRpcProcessExit): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this.resolveExit?.(info);
    if (this.stateValue === "closed") return;
    const stderrTail = this.stderr.text(20);
    const failure =
      info.error ??
      (info.code === 0
        ? new NekRpcClosedError("nek RPC process exited")
        : new NekRpcProcessExitedError(info.code, info.signal, stderrTail, info.error));
    this.rejectAllPending(failure);
    this.uiRouter.cancelAll();
    for (const listener of Array.from(this.exitListeners)) {
      try {
        listener(info);
      } catch (error) {
        this.options.logger?.warn("nek exit listener threw", error);
      }
    }
    if (this.stateValue === "open") this.finalize(info);
  }

  private failProtocol(error: Error): void {
    this.options.logger?.warn("nek stdout protocol failure", error);
    if (this.stateValue !== "open") return;
    this.rejectAllPending(error);
    this.handle.kill();
  }

  private finalize(info: NekRpcProcessExit): void {
    if (this.stateValue === "closed") return;
    this.stateValue = "closed";
    this.rejectAllPending(new NekRpcClosedError("nek RPC client closed"));
    this.uiRouter.cancelAll();
    this.detachStdout?.();
    this.detachStdout = undefined;
    this.detachStderr?.();
    this.detachStderr = undefined;
    this.exitSubscription();
    this.listeners.clear();
    this.anyListeners.clear();
    this.options.logger?.debug?.("nek RPC client finalized", info.code, info.signal);
  }

  private rejectAllPending(error: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true);
    this.exitPromise ??= new Promise<NekRpcProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
      void this.exitPromise?.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

/**
 * 把 nek 进程里的扩展 UI 请求转成渲染层要回答的交互事件。
 *
 * nek 的 dialog/structured 请求是**阻塞**的：进程在 `extension_ui_response` 到来前一直
 * `await`。请求在 host 有界保留到回答、显式撤销或超时；临时切走工作区不是用户拒绝。
 * 渲染层重连后从这里重放仍未回答的请求，超时上限不因重连延长。
 *
 * 请求按「工作区 + 会话」打标：新建会话前的项目信任确认还没有会话，只有工作区。
 */
import type {
  NekExtensionUiDialogAnswer,
  NekExtensionUiDialogRequest,
  NekExtensionUiRequest,
  NekExtensionUiResponse,
  NekInteractionFrame,
  NekInteractionScope,
  NekStructuredUiResponse,
} from "@zcode/shared/nek-protocol";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";

interface NekGuiInteractionBridgeTimers {
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

interface NekGuiInteractionBridgeOptions {
  /** 渲染层一直不回答时的上限（毫秒）；请求自带 `timeout` 时取两者较小值。 */
  timeoutMs: number;
  /** 同时在等的请求上限，超出按取消收口（有界内存）。 */
  maxPending: number;
  logger?: { warn: (...args: unknown[]) => void };
  timers?: NekGuiInteractionBridgeTimers;
}

interface PendingInteraction {
  scope: NekInteractionScope;
  request: NekExtensionUiRequest;
  timer: unknown;
  /** 取消（超时、撤消、无人订阅）时回给 nek 的值。 */
  fallback: unknown;
  settle: (value: unknown) => void;
}

const DEFAULT_TIMERS: NekGuiInteractionBridgeTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function requestTimeoutMs(
  request: NekExtensionUiRequest,
  options: NekGuiInteractionBridgeOptions,
): number {
  const requested = "timeout" in request ? request.timeout : undefined;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return options.timeoutMs;
  }
  return Math.min(requested, options.timeoutMs);
}

function sameScope(left: NekInteractionScope, right: NekInteractionScope): boolean {
  return left.workspacePath === right.workspacePath && left.sessionKey === right.sessionKey;
}

/** `extension_ui_response` → nek 侧的 dialog 答案。 */
function toDialogAnswer(answer: unknown): NekExtensionUiDialogAnswer {
  const response = asResponseRecord(answer);
  if (!response) return { cancelled: true };
  if (response.cancelled === true) return { cancelled: true };
  if (typeof response.value === "string") return { value: response.value };
  if (typeof response.confirmed === "boolean") return { confirmed: response.confirmed };
  return { cancelled: true };
}

/** 只接受真实的 `extension_ui_response`，不把任意对象当成答案。 */
function asResponseRecord(answer: unknown): Record<string, unknown> | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const record = answer as Record<string, unknown>;
  return record.type === "extension_ui_response" ? record : undefined;
}

function toStructuredAnswer(answer: unknown, id: string): NekStructuredUiResponse {
  if (typeof answer !== "object" || answer === null) {
    return { type: "extension_ui_response", id, cancelled: true };
  }
  const response = answer as Partial<NekStructuredUiResponse>;
  if (response.type !== "extension_ui_response") {
    return { type: "extension_ui_response", id, cancelled: true };
  }
  return response as NekStructuredUiResponse;
}

/** 双向交互桥：向上发请求、向下收回答；订阅者就是渲染层的监听器。 */
export class NekGuiInteractionBridge {
  private readonly subscribers = new Set<(frame: NekInteractionFrame) => void>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly timers: NekGuiInteractionBridgeTimers;

  constructor(private readonly options: NekGuiInteractionBridgeOptions) {
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  /** 渲染层订阅交互帧；返回 detach。退订不结算审批，pendingFrames 负责重放。 */
  onFrame(listener: (frame: NekInteractionFrame) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** 重连/返回工作区只重放仍在等待的请求，不复制 pending 所有权或延长超时。 */
  pendingFrames(workspacePath: string): NekInteractionFrame[] {
    return [...this.pending.values()]
      .filter((entry) => entry.scope.workspacePath === workspacePath)
      .map(({ scope, request }) => ({ kind: "request", scope, request }));
  }

  /** 渲染层的回答；未知 id（已取消或已结算）返回 `false`，不静默成功。 */
  respond(response: NekExtensionUiResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;
    this.pending.delete(response.id);
    this.timers.clearTimeout(pending.timer);
    pending.settle(response);
    return true;
  }

  /** 给某个范围生成 handler：交给该范围内 nek 进程的扩展 UI 路由。 */
  scoped(scope: NekInteractionScope): NekExtensionUiHandler {
    return {
      dialog: async (request, signal) => await this.askDialog(scope, request, signal),
      structured: async (request, signal) =>
        toStructuredAnswer(
          await this.ask(scope, request, signal, cancelledAnswer(request.id)),
          request.id,
        ),
      fireAndForget: (request) => {
        if (this.subscribers.size === 0) return;
        this.publish({ kind: "request", scope, request });
      },
      cancelled: (id) => this.cancel(scope, id),
    };
  }

  /** 撤销一个范围的待回答请求（会话关闭、进程回收）。 */
  cancelScope(scope: NekInteractionScope): void {
    for (const [id, pending] of Array.from(this.pending)) {
      if (sameScope(pending.scope, scope)) this.cancel(pending.scope, id);
    }
  }

  /** 撤销 workspace 下全部待回答请求（renderer 最后一个订阅者离开）。 */
  cancelWorkspace(workspacePath: string): void {
    for (const [id, pending] of Array.from(this.pending)) {
      if (pending.scope.workspacePath === workspacePath) this.cancel(pending.scope, id);
    }
  }

  dispose(): void {
    for (const [id, pending] of Array.from(this.pending)) {
      this.pending.delete(id);
      this.timers.clearTimeout(pending.timer);
      pending.settle(pending.fallback);
    }
    this.subscribers.clear();
  }

  private async askDialog(
    scope: NekInteractionScope,
    request: NekExtensionUiDialogRequest,
    signal: AbortSignal,
  ): Promise<NekExtensionUiDialogAnswer> {
    const answer = await this.ask(scope, request, signal, { cancelled: true });
    return toDialogAnswer(answer);
  }

  private async ask(
    scope: NekInteractionScope,
    request: NekExtensionUiRequest,
    signal: AbortSignal,
    fallback: unknown,
  ): Promise<unknown> {
    const id = request.id;
    if (signal.aborted || !this.canAsk()) return fallback;
    const answer = new Promise<unknown>((resolve) => {
      const onAbort = () => escalate("was cancelled by nek");
      const settle = (value: unknown) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const escalate = (reason: string) => {
        this.options.logger?.warn(`interaction ${id} ${reason}; answering cancelled`);
        this.cancel(scope, id);
      };
      const entry: PendingInteraction = { scope, request, timer: undefined, fallback, settle };
      // 先登记再起定时器：注入的定时器实现可能是同步的，不能让它抢在登记之前。
      this.pending.set(id, entry);
      entry.timer = this.timers.setTimeout(
        () => escalate("timed out"),
        requestTimeoutMs(request, this.options),
      );
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.publish({ kind: "request", scope, request });
    return await answer;
  }

  /** 并发已达上限时拒绝登记；没有订阅者的请求仍受原超时与相同容量限制。 */
  private canAsk(): boolean {
    if (this.pending.size >= this.options.maxPending) {
      this.options.logger?.warn(
        `pending interactions reached the limit (${this.options.maxPending}); answering cancelled`,
      );
      return false;
    }
    return true;
  }

  private cancel(scope: NekInteractionScope, id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.timers.clearTimeout(pending.timer);
    pending.settle(pending.fallback);
    this.publish({ kind: "cancel", scope, id });
  }

  private publish(event: NekInteractionFrame): void {
    for (const listener of Array.from(this.subscribers)) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.warn("GUI interaction listener threw", error);
      }
    }
  }
}

function cancelledAnswer(id: string): NekStructuredUiResponse {
  return { type: "extension_ui_response", id, cancelled: true };
}

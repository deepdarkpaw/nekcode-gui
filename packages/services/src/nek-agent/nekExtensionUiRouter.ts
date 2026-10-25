import type {
  NekExtensionUiDialogAnswer,
  NekExtensionUiDialogRequest,
  NekExtensionUiFireAndForgetRequest,
  NekExtensionUiRequest,
  NekExtensionUiResponse,
  NekStructuredUiRequest,
  NekStructuredUiResponse,
} from "@zcode/shared/nek-protocol";

/**
 * 扩展 UI 请求的路由（与协议客户端解耦，便于单独测试）。
 *
 * 三类行为（`docs/rpc-extension-ui.md`）：
 * - **dialog**（select/confirm/input/editor）：必须回 `extension_ui_response`，否则 nek 侧的
 *   `await` 永远挂着；
 * - **fire-and-forget**（notify/setStatus/setWidget/setTitle/set_editor_text）：只通知，不回；
 * - **structured**（GUI 新增）：等价于 dialog，但结果是结构化 JSON。
 *
 * `extension_ui_cancel` 到达时撤销对应请求：abort 注入的 signal 并回调 `cancelled`，
 * GUI 据此关掉已经打开的对话框（回合中止后不留孤儿窗口）。
 */

/** GUI 实现的处理器；未实现的方法一律按"取消"回给 nek，绝不让对端悬挂。 */
export interface NekExtensionUiHandler {
  dialog?: (
    request: NekExtensionUiDialogRequest,
    signal: AbortSignal,
  ) => Promise<NekExtensionUiDialogAnswer | undefined> | NekExtensionUiDialogAnswer | undefined;
  structured?: (
    request: NekStructuredUiRequest,
    signal: AbortSignal,
  ) => Promise<NekStructuredUiResponse | undefined> | NekStructuredUiResponse | undefined;
  fireAndForget?: (request: NekExtensionUiFireAndForgetRequest) => void;
  /** 被 nek 侧撤销（或本端关闭时统一撤销）。 */
  cancelled?: (id: string, request: NekExtensionUiRequest) => void;
}

export interface NekExtensionUiRouterOptions {
  handler?: NekExtensionUiHandler;
  /** 把响应写回 stdin；由客户端提供。 */
  respond: (response: NekExtensionUiResponse) => void;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function isDialogRequest(request: NekExtensionUiRequest): request is NekExtensionUiDialogRequest {
  return DIALOG_METHODS.has(request.method);
}

export class NekExtensionUiRouter {
  private readonly inFlight = new Map<
    string,
    { controller: AbortController; request: NekExtensionUiRequest }
  >();

  constructor(private readonly options: NekExtensionUiRouterOptions) {}

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** 处理一条 `extension_ui_request`；异步完成，不阻塞事件分发。 */
  handle(request: NekExtensionUiRequest): void {
    const controller = new AbortController();
    this.inFlight.set(request.id, { controller, request });
    void this.route(request, controller)
      .catch((error) => {
        // 处理器抛错：回 cancelled，绝不让 nek 侧留下一个永远等不到答案的对话框。
        this.options.logger?.warn(`extension UI handler failed for ${request.method}`, error);
        this.cancelResponse(request.id);
      })
      .finally(() => {
        this.inFlight.delete(request.id);
      });
  }

  /** `extension_ui_cancel`：撤销并通知 GUI 关闭对话框。 */
  cancel(id: string): void {
    const entry = this.inFlight.get(id);
    if (!entry) return;
    this.inFlight.delete(id);
    entry.controller.abort();
    this.options.handler?.cancelled?.(id, entry.request);
  }

  /** 客户端关闭时统一撤销。 */
  cancelAll(): void {
    for (const id of Array.from(this.inFlight.keys())) this.cancel(id);
  }

  private async route(request: NekExtensionUiRequest, controller: AbortController): Promise<void> {
    if (request.method === "structured") {
      await this.routeStructured(request, controller);
      return;
    }
    if (isDialogRequest(request)) {
      await this.routeDialog(request, controller);
      return;
    }
    this.options.handler?.fireAndForget?.(request);
  }

  private async routeDialog(
    request: NekExtensionUiDialogRequest,
    controller: AbortController,
  ): Promise<void> {
    const handler = this.options.handler?.dialog;
    if (!handler) {
      this.cancelResponse(request.id);
      return;
    }
    const answer = await handler(request, controller.signal);
    if (controller.signal.aborted) return;
    if (!answer || "cancelled" in answer) {
      this.cancelResponse(request.id);
      return;
    }
    if ("confirmed" in answer) {
      this.options.respond({
        type: "extension_ui_response",
        id: request.id,
        confirmed: answer.confirmed,
      });
      return;
    }
    this.options.respond({ type: "extension_ui_response", id: request.id, value: answer.value });
  }

  private async routeStructured(
    request: NekStructuredUiRequest,
    controller: AbortController,
  ): Promise<void> {
    const handler = this.options.handler?.structured;
    if (!handler) {
      this.cancelResponse(request.id);
      return;
    }
    const answer = await handler(request, controller.signal);
    if (controller.signal.aborted) return;
    this.options.respond(
      answer ?? { type: "extension_ui_response", id: request.id, cancelled: true },
    );
  }

  private cancelResponse(id: string): void {
    this.options.respond({ type: "extension_ui_response", id, cancelled: true });
  }
}

/**
 * nek 扩展 UI 交互的 renderer 通道。
 *
 * 服务层已经有一条双向交互桥（`NekGuiInteractionBridge`）：nek 进程的 dialog/structured
 * 请求在那里等回答。这里只负责把它挂到 `IZCodeAgentService` 的 dynamic event 面：
 * 渲染层按 workspace 订阅 `onDynamicNekInteractionFrame`，用 `respondNekInteraction` 回答。
 *
 * 订阅是懒的：没有渲染层订阅时不向服务登记，服务侧因此可以直接把请求按取消收口，
 * 不会让 nek 等一个永远不会来的回答。
 */
import { Emitter, type Event } from "@zcode/rpc";
import type { NekExtensionUiResponse, NekInteractionFrame } from "@zcode/shared/nek-protocol";
import type { NekAgentService } from "../service/nekAgentService.js";
import { workspaceKey } from "./frameHelpers.js";
import type { NekWorkspaceTarget } from "./types.js";

export class NekAgentInteractionChannel {
  private readonly emitters = new Map<string, Emitter<NekInteractionFrame>>();
  private subscriberCount = 0;
  private detachService: (() => void) | undefined;

  constructor(private readonly service: NekAgentService) {}

  onDynamic(target: NekWorkspaceTarget): Event<NekInteractionFrame> {
    return this.emitter(workspaceKey(target)).event;
  }

  async respond(response: NekExtensionUiResponse): Promise<void> {
    if (!this.service.respondInteraction(response)) {
      throw new Error(`nek interaction ${response.id} is no longer pending`);
    }
  }

  dispose(): void {
    this.detachService?.();
    this.detachService = undefined;
    this.subscriberCount = 0;
    for (const emitter of this.emitters.values()) emitter.dispose();
    this.emitters.clear();
  }

  /** emitter 与 renderer 订阅一一对应：最后一个订阅者离开就连同服务订阅一起回收。 */
  private emitter(workspace: string): Emitter<NekInteractionFrame> {
    const existing = this.emitters.get(workspace);
    if (existing) return existing;
    const emitter = new Emitter<NekInteractionFrame>({
      onWillAddFirstListener: () => this.attachService(),
      onDidRemoveLastListener: () => {
        this.service.cancelWorkspaceInteractions(workspace);
        this.detachIfIdle();
        this.emitters.delete(workspace);
      },
    });
    this.emitters.set(workspace, emitter);
    return emitter;
  }

  private attachService(): void {
    this.subscriberCount += 1;
    this.detachService ??= this.service.onInteractionEvent((event) => this.publish(event));
  }

  private detachIfIdle(): void {
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
    if (this.subscriberCount > 0) return;
    this.detachService?.();
    this.detachService = undefined;
  }

  private publish(frame: NekInteractionFrame): void {
    const sessionId =
      frame.scope.sessionId ??
      (frame.scope.sessionKey
        ? this.service.getSession(frame.scope.sessionKey)?.sessionId
        : undefined);
    const mappedFrame: NekInteractionFrame = sessionId
      ? { ...frame, scope: { ...frame.scope, sessionId } }
      : frame;
    const emitter = this.emitters.get(
      workspaceKey({ workspacePath: mappedFrame.scope.workspacePath }),
    );
    emitter?.fire(mappedFrame);
  }
}

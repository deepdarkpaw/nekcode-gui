/**
 * 工作区交互订阅：身份键定位订阅，真实路径定位 nek 事件。
 * pending 的唯一所有者是 service 的交互桥；切换 pane/重连不代表拒绝，返回时重放未答请求。
 */
import { Emitter, toDisposable, type Event } from "@zcode/rpc";
import type { NekExtensionUiResponse, NekInteractionFrame } from "@zcode/shared/nek-protocol";
import type { NekAgentService } from "../service/nekAgentService.js";
import { workspaceKey } from "./frameHelpers.js";
import type { NekWorkspaceTarget } from "./types.js";

interface InteractionSubscription {
  workspacePath: string;
  emitter: Emitter<NekInteractionFrame>;
  listeners: number;
}

export class NekAgentInteractionChannel {
  private readonly entries = new Map<string, InteractionSubscription>();
  private detachService: (() => void) | undefined;

  constructor(private readonly service: NekAgentService) {}

  onDynamic(target: NekWorkspaceTarget): Event<NekInteractionFrame> {
    return (listener) => {
      const key = workspaceKey(target);
      let entry = this.entries.get(key);
      if (entry && entry.workspacePath !== target.workspacePath)
        throw new Error("nek interaction workspace identity refers to a different path");
      if (!entry) {
        entry = { workspacePath: target.workspacePath, emitter: new Emitter(), listeners: 0 };
        this.entries.set(key, entry);
      }
      entry.listeners += 1;
      this.detachService ??= this.service.onInteractionEvent((frame) => this.publish(frame));
      const disposable = entry.emitter.event(listener);
      const lease = toDisposable(() => {
        disposable.dispose();
        if (this.entries.get(key) !== entry) return;
        entry.listeners -= 1;
        if (entry.listeners > 0) return;
        entry.emitter.dispose();
        this.entries.delete(key);
        if (this.entries.size > 0) return;
        this.detachService?.();
        this.detachService = undefined;
      });
      try {
        // 先挂监听再重放，只发给新订阅者；同步响应可立即从 host pending 集合删除。
        for (const frame of this.service.pendingInteractions(target.workspacePath))
          listener(this.mapSession(frame));
      } catch (error) {
        lease.dispose();
        throw error;
      }
      return lease;
    };
  }

  async respond(response: NekExtensionUiResponse): Promise<void> {
    if (!this.service.respondInteraction(response))
      throw new Error(`nek interaction ${response.id} is no longer pending`);
  }

  dispose(): void {
    this.detachService?.();
    this.detachService = undefined;
    for (const entry of this.entries.values()) entry.emitter.dispose();
    this.entries.clear();
  }

  private mapSession(frame: NekInteractionFrame): NekInteractionFrame {
    const sessionId =
      frame.scope.sessionId ??
      (frame.scope.sessionKey
        ? this.service.getSession(frame.scope.sessionKey)?.sessionId
        : undefined);
    return sessionId ? { ...frame, scope: { ...frame.scope, sessionId } } : frame;
  }

  private publish(frame: NekInteractionFrame): void {
    const mapped = this.mapSession(frame);
    for (const entry of this.entries.values()) {
      if (entry.workspacePath === frame.scope.workspacePath) entry.emitter.fire(mapped);
    }
  }
}

import { Emitter, type Event } from "@zcode/rpc";
import type {
  ConversationTopicFrame,
  ConversationTopicWireCandidate,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { NekAgentService } from "../service/nekAgentService.js";
import { makeSubscriptionId, makeTopicWireFrames, workspaceKey } from "./frameHelpers.js";
import type {
  NekConversationResyncParams,
  NekConversationSubscribeParams,
  NekConversationUnsubscribeParams,
  NekSessionBinding,
  NekWorkspaceTarget,
} from "./types.js";

const MAX_CONVERSATION_SUBSCRIPTIONS = 128;

interface ConversationSubscription {
  id: string;
  workspaceKey: string;
  sessionKey: string;
  topic: string;
  /** 实时帧与恢复帧共用；客户端丢弃不大于已处理最大序号的帧。 */
  ordinal: number;
  detach: () => void;
}

/**
 * v4 会话主题的订阅表：每个订阅一条 wire 序号线，每个 workspace 一个帧 emitter。
 *
 * 恢复帧必须沿用同一条序号线：若用订阅建立时的旧序号，有实时帧之后的 resync 帧
 * 会被客户端当作过期帧丢弃，恢复只能超时。
 */
export class NekConversationSubscriptions {
  private readonly subscriptions = new Map<string, ConversationSubscription>();
  private readonly emitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();

  constructor(
    private readonly service: NekAgentService,
    private readonly ensureBinding: (
      target: NekWorkspaceTarget,
      sessionId: string,
    ) => Promise<NekSessionBinding>,
  ) {}

  async subscribe(input: NekConversationSubscribeParams): Promise<V4ConversationSubscribeResult> {
    if (this.subscriptions.size >= MAX_CONVERSATION_SUBSCRIPTIONS)
      throw new Error(
        `nek conversation subscription limit exceeded (${MAX_CONVERSATION_SUBSCRIPTIONS})`,
      );
    const binding = await this.ensureBinding(input, input.sessionId);
    const topic = `conversation/${input.sessionId}`;
    const subscription: ConversationSubscription = {
      id: makeSubscriptionId(topic),
      workspaceKey: workspaceKey(input),
      sessionKey: binding.sessionKey,
      topic,
      ordinal: 0,
      detach: () => {},
    };
    let firstFrame: ConversationTopicFrame | undefined;
    let initialError: unknown;
    subscription.detach = await this.service.subscribeConversation(binding.sessionKey, (frame) => {
      const deliveryKind = firstFrame ? "online" : "initial";
      firstFrame ??= frame;
      try {
        this.emit(subscription, { ...frame, topic }, deliveryKind);
      } catch (error) {
        // 投影器隔离 listener 异常；首帧编码失败必须转成订阅失败，不能成功 ACK 后等超时。
        if (deliveryKind !== "initial") throw error;
        initialError = error;
      }
    });
    if (initialError !== undefined) {
      subscription.detach();
      throw initialError;
    }
    this.subscriptions.set(subscription.id, subscription);
    const logEpoch =
      firstFrame?.payload.kind === "snapshot" ? firstFrame.payload.snapshot.logEpoch : "nek-1";
    return { ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch } };
  }

  async resync(input: NekConversationResyncParams): Promise<V4ConversationResyncResult> {
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (!subscription) throw new Error(`unknown conversation subscription ${input.subscriptionId}`);
    const snapshot = this.service.conversationSnapshot(subscription.sessionKey);
    const frame: ConversationTopicFrame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    this.emit(subscription, frame, "recovery");
    return {
      ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch: snapshot.logEpoch },
    };
  }

  unsubscribe(input: NekConversationUnsubscribeParams): void {
    const subscription = this.subscriptions.get(input.subscriptionId);
    if (!subscription) return;
    subscription.detach();
    this.subscriptions.delete(input.subscriptionId);
  }

  onDynamicFrame(target: NekWorkspaceTarget): Event<ConversationTopicWireCandidate> {
    return this.emitter(workspaceKey(target)).event;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.values()) subscription.detach();
    this.subscriptions.clear();
    for (const emitter of this.emitters.values()) emitter.dispose();
    this.emitters.clear();
  }

  private emit(
    subscription: ConversationSubscription,
    frame: ConversationTopicFrame,
    deliveryKind: "initial" | "online" | "recovery",
  ): void {
    subscription.ordinal += 1;
    const emitter = this.emitter(subscription.workspaceKey);
    for (const wire of makeTopicWireFrames(
      frame,
      subscription.id,
      subscription.ordinal,
      deliveryKind,
    )) {
      emitter.fire(wire);
    }
  }

  private emitter(workspace: string): Emitter<ConversationTopicWireCandidate> {
    let emitter = this.emitters.get(workspace);
    if (!emitter) {
      emitter = new Emitter<ConversationTopicWireCandidate>();
      this.emitters.set(workspace, emitter);
    }
    return emitter;
  }
}

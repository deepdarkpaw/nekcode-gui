import { Emitter, type Event } from "@zcode/rpc";
import type {
  NekModel,
  NekRpcSessionState,
  NekRpcSlashCommand,
  NekSessionSummary,
} from "@zcode/shared/nek-protocol";
import type {
  ConversationTopicFrame,
  SessionsIndexSnapshot,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireCandidate,
  SubscribeAck,
  V4ConversationResyncResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigSnapshot,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { NekSessionIndexSyncer } from "../index/nekSessionIndexSyncer.js";
import type { NekSessionIndexItem } from "../index/types.js";
import type { NekAgentService } from "../service/nekAgentService.js";
import type { NekAgentServiceEvent } from "../service/types.js";
import { makeSessionsIndexWireFrame, makeWorkspaceConfigWireFrame } from "./frameHelpers.js";
import type {
  NekConversationResyncParams,
  NekConversationUnsubscribeParams,
  NekSessionsIndexSubscribeParams,
  NekWorkspaceConfigSubscribeParams,
  NekWorkspaceTarget,
} from "./types.js";
import { makeSubscriptionId, workspaceKey } from "./frameHelpers.js";

interface IndexSubscription {
  id: string;
  workspaceKey: string;
  topic: string;
  ordinal: number;
}

interface ConfigSubscription {
  id: string;
  workspaceKey: string;
  topic: string;
  ordinal: number;
}

interface TopicState<T> {
  logEpoch: string;
  seq: number;
  snapshot?: T;
}

const MAX_SUBSCRIPTIONS = 128;

function sessionPhase(summary: NekSessionSummary): "draft" | "prewarming" | "running" | "completedSuccess" | "completedInterrupted" | "error" {
  return summary.locked ? "completedInterrupted" : summary.messageCount > 0 ? "completedSuccess" : "draft";
}

function sessionSummary(item: NekSessionIndexItem, workspaceId: string) {
  const summary = item.summary;
  if (!summary) return undefined;
  const phase = sessionPhase(summary);
  return {
    sessionId: summary.id,
    workspaceId,
    title: (summary.name ?? summary.firstMessage) || "未命名会话",
    phase,
    sessionEnded: phase === "completedSuccess" || phase === "completedInterrupted",
    hasBackgroundWork: false,
    lastActivityAt: Date.parse(summary.modifiedAt),
    createdAt: Date.parse(summary.createdAt),
  };
}

function ack(subscriptionId: string, logEpoch: string, mode: "snapshot" | "resume"): SubscribeAck {
  return { subscriptionId, mode, logEpoch };
}

function modelOptions(models: NekModel[]) {
  return models.map((model) => ({
    value: `${model.provider}/${model.id}`,
    name: model.name,
    ...(model.reasoning ? { description: "支持思考" } : {}),
    modelProviderId: model.provider,
    modelProviderName: model.provider,
    modelThoughtLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }));
}

export class NekAgentServiceTopics {
  private readonly indexSubscriptions = new Map<string, IndexSubscription>();
  private readonly configSubscriptions = new Map<string, ConfigSubscription>();
  private readonly indexEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  private readonly configEmitters = new Map<string, Emitter<WorkspaceConfigTopicWireCandidate>>();
  private readonly indexState = new Map<string, TopicState<SessionsIndexSnapshot>>();
  private readonly configState = new Map<string, TopicState<WorkspaceConfigSnapshot>>();
  private readonly detachServiceEvent: () => void;

  constructor(
    private readonly service: NekAgentService,
    private readonly resolveSessionKey: (target: NekWorkspaceTarget) => string | undefined,
    private readonly syncer: NekSessionIndexSyncer,
    private readonly maxSubscriptions = MAX_SUBSCRIPTIONS,
  ) {
    this.detachServiceEvent = service.onEvent((event) => this.handleServiceEvent(event));
  }

  onDynamicSessionsIndexFrame(target: NekWorkspaceTarget): Event<SessionsIndexTopicWireCandidate> {
    return this.indexEmitter(workspaceKey(target)).event;
  }

  onDynamicWorkspaceConfigFrame(target: NekWorkspaceTarget): Event<WorkspaceConfigTopicWireCandidate> {
    return this.configEmitter(workspaceKey(target)).event;
  }

  async subscribeSessionsIndexV4(
    input: NekSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult> {
    this.assertCapacity();
    const id = makeSubscriptionId(`sessions-index/${workspaceKey(input)}`);
    const workspaceId = workspaceKey(input);
    const subscription: IndexSubscription = {
      id,
      workspaceKey: workspaceId,
      topic: `sessions-index/${workspaceId}`,
      ordinal: 0,
    };
    this.indexSubscriptions.set(id, subscription);
    const snapshot = await this.syncIndex(input);
    this.pushIndex(subscription, snapshot, "initial");
    const state = this.indexState.get(workspaceId);
    if (!state) throw new Error(`missing sessions-index state for ${workspaceId}`);
    return { ack: ack(id, state.logEpoch, "snapshot") };
  }

  async resyncSessionsIndexV4(input: NekConversationResyncParams): Promise<V4ConversationResyncResult> {
    const subscription = this.indexSubscriptions.get(input.subscriptionId);
    if (!subscription) throw new Error(`unknown sessions-index subscription ${input.subscriptionId}`);
    const snapshot = await this.syncIndex(input);
    this.pushIndex(subscription, snapshot, "recovery");
    const state = this.indexState.get(subscription.workspaceKey);
    if (!state) throw new Error(`missing sessions-index state for ${subscription.workspaceKey}`);
    return { ack: ack(subscription.id, state.logEpoch, "snapshot") };
  }

  async unsubscribeSessionsIndexV4(input: NekConversationUnsubscribeParams): Promise<void> {
    this.indexSubscriptions.delete(input.subscriptionId);
  }

  async subscribeWorkspaceConfigV4(
    input: NekWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult> {
    this.assertCapacity();
    const id = makeSubscriptionId(`workspace-config/${workspaceKey(input)}`);
    const workspaceId = workspaceKey(input);
    const subscription: ConfigSubscription = {
      id,
      workspaceKey: workspaceId,
      topic: `workspace-config/${workspaceId}`,
      ordinal: 0,
    };
    this.configSubscriptions.set(id, subscription);
    const snapshot = await this.syncConfig(input);
    this.pushConfig(subscription, snapshot, "initial");
    const state = this.configState.get(workspaceId);
    if (!state) throw new Error(`missing workspace-config state for ${workspaceId}`);
    return { ack: ack(id, state.logEpoch, "snapshot") };
  }

  async resyncWorkspaceConfigV4(input: NekConversationResyncParams): Promise<V4ConversationResyncResult> {
    const subscription = this.configSubscriptions.get(input.subscriptionId);
    if (!subscription) throw new Error(`unknown workspace-config subscription ${input.subscriptionId}`);
    const snapshot = await this.syncConfig(input);
    this.pushConfig(subscription, snapshot, "recovery");
    const state = this.configState.get(subscription.workspaceKey);
    if (!state) throw new Error(`missing workspace-config state for ${subscription.workspaceKey}`);
    return { ack: ack(subscription.id, state.logEpoch, "snapshot") };
  }

  async unsubscribeWorkspaceConfigV4(input: NekConversationUnsubscribeParams): Promise<void> {
    this.configSubscriptions.delete(input.subscriptionId);
  }

  async dispose(): Promise<void> {
    this.detachServiceEvent();
    for (const emitter of this.indexEmitters.values()) emitter.dispose();
    for (const emitter of this.configEmitters.values()) emitter.dispose();
    this.indexSubscriptions.clear();
    this.configSubscriptions.clear();
    this.indexState.clear();
    this.configState.clear();
  }

  private handleServiceEvent(event: NekAgentServiceEvent): void {
    if (event.type !== "state" && event.type !== "rpc_event" && event.type !== "resume_notice") return;
    const target = { workspacePath: event.session.cwd };
    const workspaceId = workspaceKey(target);
    if (this.indexSubscriptionsHas(workspaceId)) void this.publishIndex(target);
    if (this.configSubscriptionsHas(workspaceId)) void this.publishConfig(target);
  }

  private async syncIndex(input: NekWorkspaceTarget): Promise<SessionsIndexSnapshot> {
    const result = await this.syncer.sync({ cwd: input.workspacePath });
    const workspaceId = workspaceKey(input);
    const state = this.indexState.get(workspaceId) ?? { logEpoch: `nek-index:${workspaceId}`, seq: 0 };
    state.seq += 1;
    const sessions = result.items
      .map((item) => sessionSummary(item, workspaceId))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    const snapshot: SessionsIndexSnapshot = {
      protocolVersion: 1,
      workspaceId,
      logEpoch: state.logEpoch,
      sessions,
    };
    state.snapshot = snapshot;
    this.indexState.set(workspaceId, state);
    return snapshot;
  }

  private async syncConfig(input: NekWorkspaceTarget): Promise<WorkspaceConfigSnapshot> {
    const workspaceId = workspaceKey(input);
    const sessionKey = this.resolveSessionKey(input);
    const models = sessionKey
      ? await this.service.getAvailableModels(sessionKey)
      : await this.service.commandContext().control().then(async (client) => {
          return (await client.call({ type: "get_available_models" })).models;
        });
    const state = sessionKey ? await this.service.getState(sessionKey) : undefined;
    const commands: NekRpcSlashCommand[] = sessionKey
      ? await this.service.getCommands(sessionKey)
      : [];
    const nekState = sessionKey ? await this.service.getNekState(sessionKey) : undefined;
    const config: WorkspaceConfigState = {
      configOptions: [
        {
          id: "model",
          name: "模型",
          type: "select",
          currentValue: state?.model ? `${state.model.provider}/${state.model.id}` : "",
          options: modelOptions(models),
        },
        {
          id: "thought_level",
          name: "思考等级",
          type: "select",
          currentValue: state?.thinkingLevel ?? "medium",
          options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
            value,
            name: value,
          })),
        },
        {
          id: "mode",
          name: "模式",
          type: "select",
          currentValue: nekState?.mode ?? "agent",
          options: [
            { value: "agent", name: "Agent" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
      slashCommands: commands.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        source: command.source === "extension" ? "custom" : "builtin",
      })),
    };
    const topicState = this.configState.get(workspaceId) ?? {
      logEpoch: `nek-config:${workspaceId}`,
      seq: 0,
    };
    topicState.seq += 1;
    const snapshot: WorkspaceConfigSnapshot = {
      protocolVersion: 1,
      workspaceId,
      logEpoch: topicState.logEpoch,
      config,
    };
    topicState.snapshot = snapshot;
    this.configState.set(workspaceId, topicState);
    return snapshot;
  }

  private async publishIndex(target: NekWorkspaceTarget): Promise<void> {
    const snapshot = await this.syncIndex(target);
    for (const subscription of this.indexSubscriptions.values()) {
      if (subscription.workspaceKey === workspaceKey(target)) this.pushIndex(subscription, snapshot, "online");
    }
  }

  private async publishConfig(target: NekWorkspaceTarget): Promise<void> {
    const snapshot = await this.syncConfig(target);
    for (const subscription of this.configSubscriptions.values()) {
      if (subscription.workspaceKey === workspaceKey(target)) this.pushConfig(subscription, snapshot, "online");
    }
  }

  private pushIndex(
    subscription: IndexSubscription,
    snapshot: SessionsIndexSnapshot,
    deliveryKind: "initial" | "online" | "recovery",
  ): void {
    const state = this.indexState.get(subscription.workspaceKey);
    if (!state) throw new Error(`missing sessions-index state for ${subscription.workspaceKey}`);
    const frame: SessionsIndexTopicFrame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: deliveryKind === "recovery" || deliveryKind === "initial" ? 0 : state.seq - 1,
      toSeq: state.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    subscription.ordinal += 1;
    this.indexEmitter(subscription.workspaceKey).fire(
      makeSessionsIndexWireFrame(frame, subscription.id, subscription.ordinal, deliveryKind),
    );
  }

  private pushConfig(
    subscription: ConfigSubscription,
    snapshot: WorkspaceConfigSnapshot,
    deliveryKind: "initial" | "online" | "recovery",
  ): void {
    const state = this.configState.get(subscription.workspaceKey);
    if (!state) throw new Error(`missing workspace-config state for ${subscription.workspaceKey}`);
    const frame: WorkspaceConfigTopicFrame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: deliveryKind === "recovery" || deliveryKind === "initial" ? 0 : state.seq - 1,
      toSeq: state.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    subscription.ordinal += 1;
    this.configEmitter(subscription.workspaceKey).fire(
      makeWorkspaceConfigWireFrame(frame, subscription.id, subscription.ordinal, deliveryKind),
    );
  }

  private indexSubscriptionsHas(workspaceId: string): boolean {
    return [...this.indexSubscriptions.values()].some((item) => item.workspaceKey === workspaceId);
  }

  private configSubscriptionsHas(workspaceId: string): boolean {
    return [...this.configSubscriptions.values()].some((item) => item.workspaceKey === workspaceId);
  }

  private indexEmitter(workspaceId: string): Emitter<SessionsIndexTopicWireCandidate> {
    let emitter = this.indexEmitters.get(workspaceId);
    if (!emitter) {
      emitter = new Emitter<SessionsIndexTopicWireCandidate>();
      this.indexEmitters.set(workspaceId, emitter);
    }
    return emitter;
  }

  private configEmitter(workspaceId: string): Emitter<WorkspaceConfigTopicWireCandidate> {
    let emitter = this.configEmitters.get(workspaceId);
    if (!emitter) {
      emitter = new Emitter<WorkspaceConfigTopicWireCandidate>();
      this.configEmitters.set(workspaceId, emitter);
    }
    return emitter;
  }

  private assertCapacity(): void {
    if (this.indexSubscriptions.size + this.configSubscriptions.size >= this.maxSubscriptions)
      throw new Error(`nek v4 subscription limit exceeded (${this.maxSubscriptions})`);
  }
}

import { isDeepStrictEqual } from "node:util";
import { Emitter, type Event } from "@zcode/rpc";
import type {
  SessionsIndexSnapshot,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireCandidate,
  V4ConversationResyncResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigSnapshot,
  WorkspaceConfigTopicFrame,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { NekSessionIndexSyncer } from "../index/nekSessionIndexSyncer.js";
import type { NekSessionIndexItem } from "../index/types.js";
import { isListedNekSession } from "./nekSessionListing.js";
import type { NekAgentService } from "../service/nekAgentService.js";
import type { NekAgentServiceEvent, NekAgentServiceOptions } from "../service/types.js";
import { makeSubscriptionId, makeTopicWireFrames, workspaceKey } from "./frameHelpers.js";
import { readNekWorkspaceConfig } from "./nekWorkspaceConfig.js";
import type {
  NekConversationResyncParams,
  NekConversationUnsubscribeParams,
  NekSessionsIndexSubscribeParams,
  NekWorkspaceConfigSubscribeParams,
  NekWorkspaceTarget,
} from "./types.js";

type TopicKind = "index" | "config";
interface Subscription {
  id: string;
  workspaceKey: string;
  topic: string;
  target: NekWorkspaceTarget;
  ordinal: number;
  ready: boolean;
}
interface TopicState<T> {
  logEpoch: string;
  seq: number;
  snapshot?: T;
  flight?: Promise<T>;
  dirty: boolean;
}
const MAX_SUBSCRIPTIONS = 128;

function sessionSummary(item: NekSessionIndexItem, workspaceId: string) {
  const summary = item.summary;
  if (!summary || !isListedNekSession(summary)) return undefined;
  return {
    sessionId: summary.id,
    workspaceId,
    title: summary.name ?? summary.firstMessage,
    phase: summary.locked ? ("completedInterrupted" as const) : ("completedSuccess" as const),
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: Date.parse(summary.modifiedAt),
    createdAt: Date.parse(summary.createdAt),
  };
}

/** Workspace facts refresh on semantic changes, never on individual streaming chunks. */
export class NekAgentServiceTopics {
  private readonly indexSubscriptions = new Map<string, Subscription>();
  private readonly configSubscriptions = new Map<string, Subscription>();
  private readonly indexEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  private readonly configEmitters = new Map<string, Emitter<WorkspaceConfigTopicWireCandidate>>();
  private readonly indexState = new Map<string, TopicState<SessionsIndexSnapshot>>();
  private readonly configState = new Map<string, TopicState<WorkspaceConfigSnapshot>>();
  private readonly detachServiceEvent: () => void;
  private disposed = false;

  constructor(
    private readonly service: NekAgentService,
    private readonly resolveSessionKey: (target: NekWorkspaceTarget) => string | undefined,
    private readonly syncer: NekSessionIndexSyncer,
    private readonly maxSubscriptions = MAX_SUBSCRIPTIONS,
    private readonly logger?: NekAgentServiceOptions["logger"],
  ) {
    this.detachServiceEvent = service.onEvent((event) => this.handleServiceEvent(event));
  }

  onDynamicSessionsIndexFrame(target: NekWorkspaceTarget): Event<SessionsIndexTopicWireCandidate> {
    return this.indexEmitter(workspaceKey(target)).event;
  }
  onDynamicWorkspaceConfigFrame(
    target: NekWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate> {
    return this.configEmitter(workspaceKey(target)).event;
  }

  private addSubscription(target: NekWorkspaceTarget, kind: TopicKind): Subscription {
    if (this.disposed) throw new Error("nek workspace topics are disposed");
    if (this.indexSubscriptions.size + this.configSubscriptions.size >= this.maxSubscriptions)
      throw new Error(`nek v4 subscription limit exceeded (${this.maxSubscriptions})`);
    const key = workspaceKey(target);
    const topic = `${kind === "index" ? "sessions-index" : "workspace-config"}/${key}`;
    const subscription = {
      id: makeSubscriptionId(topic),
      workspaceKey: key,
      topic,
      target,
      ordinal: 0,
      ready: false,
    };
    (kind === "index" ? this.indexSubscriptions : this.configSubscriptions).set(
      subscription.id,
      subscription,
    );
    return subscription;
  }

  async subscribeSessionsIndexV4(
    input: NekSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult> {
    const subscription = this.addSubscription(input, "index");
    try {
      await this.syncIndex(input);
      const snapshot = this.indexState.get(subscription.workspaceKey)?.snapshot;
      if (!snapshot) throw new Error("nek index subscription retired");
      this.pushIndex(subscription, snapshot, "initial");
      subscription.ready = true;
      return {
        ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch: snapshot.logEpoch },
      };
    } catch (error) {
      await this.unsubscribeSessionsIndexV4({ ...input, subscriptionId: subscription.id });
      throw error;
    }
  }

  async resyncSessionsIndexV4(
    input: NekConversationResyncParams,
  ): Promise<V4ConversationResyncResult> {
    const subscription = this.indexSubscriptions.get(input.subscriptionId);
    if (!subscription)
      throw new Error(`unknown sessions-index subscription ${input.subscriptionId}`);
    await this.syncIndex(subscription.target);
    const snapshot = this.indexState.get(subscription.workspaceKey)?.snapshot;
    if (!snapshot) throw new Error("nek index subscription retired");
    this.pushIndex(subscription, snapshot, "recovery");
    return {
      ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch: snapshot.logEpoch },
    };
  }

  async unsubscribeSessionsIndexV4(input: NekConversationUnsubscribeParams): Promise<void> {
    const subscription = this.indexSubscriptions.get(input.subscriptionId);
    this.indexSubscriptions.delete(input.subscriptionId);
    if (subscription && !this.hasSubscribers("index", subscription.workspaceKey))
      this.indexState.delete(subscription.workspaceKey);
  }

  async subscribeWorkspaceConfigV4(
    input: NekWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult> {
    const subscription = this.addSubscription(input, "config");
    try {
      await this.syncConfig(input);
      const snapshot = this.configState.get(subscription.workspaceKey)?.snapshot;
      if (!snapshot) throw new Error("nek config subscription retired");
      this.pushConfig(subscription, snapshot, "initial");
      subscription.ready = true;
      return {
        ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch: snapshot.logEpoch },
      };
    } catch (error) {
      await this.unsubscribeWorkspaceConfigV4({ ...input, subscriptionId: subscription.id });
      throw error;
    }
  }

  async resyncWorkspaceConfigV4(
    input: NekConversationResyncParams,
  ): Promise<V4ConversationResyncResult> {
    const subscription = this.configSubscriptions.get(input.subscriptionId);
    if (!subscription)
      throw new Error(`unknown workspace-config subscription ${input.subscriptionId}`);
    await this.syncConfig(subscription.target);
    const snapshot = this.configState.get(subscription.workspaceKey)?.snapshot;
    if (!snapshot) throw new Error("nek config subscription retired");
    this.pushConfig(subscription, snapshot, "recovery");
    return {
      ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch: snapshot.logEpoch },
    };
  }

  async unsubscribeWorkspaceConfigV4(input: NekConversationUnsubscribeParams): Promise<void> {
    const subscription = this.configSubscriptions.get(input.subscriptionId);
    this.configSubscriptions.delete(input.subscriptionId);
    if (subscription && !this.hasSubscribers("config", subscription.workspaceKey))
      this.configState.delete(subscription.workspaceKey);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.detachServiceEvent();
    for (const emitter of this.indexEmitters.values()) emitter.dispose();
    for (const emitter of this.configEmitters.values()) emitter.dispose();
    this.indexSubscriptions.clear();
    this.configSubscriptions.clear();
    this.indexState.clear();
    this.configState.clear();
    this.indexEmitters.clear();
    this.configEmitters.clear();
  }

  private handleServiceEvent(event: NekAgentServiceEvent): void {
    let index = false;
    let config = false;
    let mode: string | undefined;
    const cwd = event.type === "catalog_changed" ? event.cwd : event.session.cwd;
    if (event.type === "catalog_changed") {
      index = event.topic === "index";
      config = event.topic === "config";
    } else if (event.type === "process_attached") {
      index = config = true;
    } else if (event.type === "state" || event.type === "process_exit") {
      index = true;
    } else if (event.type === "rpc_event") {
      const rpc = event.event;
      index =
        rpc.type === "message_end" ||
        rpc.type === "agent_settled" ||
        rpc.type === "session_info_changed" ||
        rpc.type === "entry_appended";
      config =
        rpc.type === "thinking_level_changed" ||
        (rpc.type === "entry_appended" &&
          (rpc.entry.type === "model_change" || rpc.entry.type === "thinking_level_change"));
      if (rpc.type === "extension_event" && rpc.name === "nek.state") {
        const value = (rpc.payload as { mode?: unknown } | null)?.mode;
        if (typeof value === "string") {
          mode = value;
          config = true;
        }
      }
    }
    if (!index && !config) return;
    const targets = new Map<string, NekWorkspaceTarget>();
    for (const subscription of [
      ...this.indexSubscriptions.values(),
      ...this.configSubscriptions.values(),
    ]) {
      if (cwd === undefined || subscription.target.workspacePath === cwd)
        targets.set(subscription.workspaceKey, subscription.target);
    }
    for (const [key, target] of targets) {
      if (index) this.invalidate("index", target);
      const currentMode = this.configState
        .get(key)
        ?.snapshot?.config.configOptions.find((option) => option.id === "mode")?.currentValue;
      if (config && (mode === undefined || mode !== currentMode)) this.invalidate("config", target);
    }
  }

  /** One in-flight read plus one dirty bit per subscribed workspace/topic; no queued refresh jobs. */
  private invalidate(kind: TopicKind, target: NekWorkspaceTarget): void {
    const key = workspaceKey(target);
    if (this.disposed || !this.hasSubscribers(kind, key)) return;
    const state = kind === "index" ? this.indexState.get(key) : this.configState.get(key);
    if (state?.flight) {
      state.dirty = true;
      return;
    }
    const flight = kind === "index" ? this.syncIndex(target) : this.syncConfig(target);
    void flight.catch((error) => {
      if (!this.disposed && this.hasSubscribers(kind, key))
        this.logger?.warn("nek workspace topic refresh failed", { kind, error });
    });
  }

  private syncIndex(target: NekWorkspaceTarget): Promise<SessionsIndexSnapshot> {
    const key = workspaceKey(target);
    let state = this.indexState.get(key);
    if (!state) {
      state = { logEpoch: `nek-index:${key}`, seq: 0, dirty: false };
      this.indexState.set(key, state);
    }
    const current = state;
    if (current.flight) return current.flight;
    current.flight = this.syncer
      .sync({ cwd: target.workspacePath })
      .then((result) => {
        if (this.disposed || this.indexState.get(key) !== current)
          throw new Error("nek index refresh retired");
        const snapshot: SessionsIndexSnapshot = {
          protocolVersion: 1,
          workspaceId: key,
          logEpoch: current.logEpoch,
          sessions: result.items
            .map((item) => sessionSummary(item, key))
            .filter((item) => item !== undefined),
        };
        if (!isDeepStrictEqual(current.snapshot, snapshot)) {
          current.seq++;
          for (const subscription of this.indexSubscriptions.values())
            if (subscription.ready && subscription.workspaceKey === key)
              this.pushIndex(subscription, snapshot, "online");
          current.snapshot = snapshot;
        }
        return current.snapshot!;
      })
      .finally(() => {
        current.flight = undefined;
        if (current.dirty && this.indexState.get(key) === current) {
          current.dirty = false;
          this.invalidate("index", target);
        }
      });
    return current.flight;
  }

  private syncConfig(target: NekWorkspaceTarget): Promise<WorkspaceConfigSnapshot> {
    const key = workspaceKey(target);
    let state = this.configState.get(key);
    if (!state) {
      state = { logEpoch: `nek-config:${key}`, seq: 0, dirty: false };
      this.configState.set(key, state);
    }
    const current = state;
    if (current.flight) return current.flight;
    current.flight = readNekWorkspaceConfig(this.service, target, this.resolveSessionKey(target))
      .then((snapshot) => {
        if (this.disposed || this.configState.get(key) !== current)
          throw new Error("nek config refresh retired");
        if (!isDeepStrictEqual(current.snapshot, snapshot)) {
          current.seq++;
          for (const subscription of this.configSubscriptions.values())
            if (subscription.ready && subscription.workspaceKey === key)
              this.pushConfig(subscription, snapshot, "online");
          current.snapshot = snapshot;
        }
        return current.snapshot!;
      })
      .finally(() => {
        current.flight = undefined;
        if (current.dirty && this.configState.get(key) === current) {
          current.dirty = false;
          this.invalidate("config", target);
        }
      });
    return current.flight;
  }

  private pushIndex(
    subscription: Subscription,
    snapshot: SessionsIndexSnapshot,
    deliveryKind: "initial" | "online" | "recovery",
  ): void {
    const state = this.indexState.get(subscription.workspaceKey);
    if (!state) throw new Error(`missing sessions-index state for ${subscription.workspaceKey}`);
    const frame: SessionsIndexTopicFrame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: deliveryKind === "online" ? state.seq - 1 : 0,
      toSeq: state.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    for (const wire of makeTopicWireFrames(
      frame,
      subscription.id,
      ++subscription.ordinal,
      deliveryKind,
    ))
      this.indexEmitter(subscription.workspaceKey).fire(wire);
  }

  private pushConfig(
    subscription: Subscription,
    snapshot: WorkspaceConfigSnapshot,
    deliveryKind: "initial" | "online" | "recovery",
  ): void {
    const state = this.configState.get(subscription.workspaceKey);
    if (!state) throw new Error(`missing workspace-config state for ${subscription.workspaceKey}`);
    const frame: WorkspaceConfigTopicFrame = {
      topic: subscription.topic,
      subscriptionId: subscription.id,
      fromSeq: deliveryKind === "online" ? state.seq - 1 : 0,
      toSeq: state.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    for (const wire of makeTopicWireFrames(
      frame,
      subscription.id,
      ++subscription.ordinal,
      deliveryKind,
    ))
      this.configEmitter(subscription.workspaceKey).fire(wire);
  }

  private hasSubscribers(kind: TopicKind, key: string): boolean {
    const subscriptions = kind === "index" ? this.indexSubscriptions : this.configSubscriptions;
    return [...subscriptions.values()].some((subscription) => subscription.workspaceKey === key);
  }
  private indexEmitter(key: string): Emitter<SessionsIndexTopicWireCandidate> {
    let emitter = this.indexEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<SessionsIndexTopicWireCandidate>();
      this.indexEmitters.set(key, emitter);
    }
    return emitter;
  }
  private configEmitter(key: string): Emitter<WorkspaceConfigTopicWireCandidate> {
    let emitter = this.configEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<WorkspaceConfigTopicWireCandidate>();
      this.configEmitters.set(key, emitter);
    }
    return emitter;
  }
}

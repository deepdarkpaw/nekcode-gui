import { randomUUID } from "node:crypto";
import { Emitter, type Event } from "@zcode/rpc";
import type {
  NekAgentMessage,
  NekMode,
  NekSessionSummary,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import type {
  CommandAck,
  CommandsQueryResult,
  ConversationSnapshot,
  ConversationTopicFrame,
  ConversationTopicWireCandidate,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { NekSessionIndexSyncer } from "../index/nekSessionIndexSyncer.js";
import { MemoryNekSessionIndexStorage } from "../index/nekSessionIndexStorage.js";
import { NekAgentService } from "../service/nekAgentService.js";
import type { NekSessionResult } from "../service/types.js";
import { toNekImages } from "./attachmentImages.js";
import {
  acceptedCommand,
  asRecord,
  makeSubscriptionId,
  makeWireFrame,
  readString,
  sessionMapKey,
  unsupportedCommand,
  workspaceKey,
} from "./frameHelpers.js";
import { NekAgentServiceTopics } from "./nekAgentServiceTopics.js";
import type {
  NekAgentServiceAdapterApi,
  NekAgentServiceAdapterOptions,
  NekConversationResyncParams,
  NekConversationSubscribeParams,
  NekConversationUnsubscribeParams,
  NekSessionCommandEnvelope,
  NekWorkspaceConfigSubscribeParams,
  NekWorkspaceTarget,
} from "./types.js";

interface SessionBinding {
  target: NekWorkspaceTarget;
  sessionKey: string;
  sessionId: string;
  sessionPath?: string;
}

interface ConversationSubscription {
  id: string;
  workspaceKey: string;
  sessionKey: string;
  topic: string;
  ordinal: number;
  detach: () => void;
}

const MAX_BINDINGS = 5_000;
const THOUGHT_LEVELS: readonly NekThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * 把 NekAgentService 接到现有 ZCode v4 host 面。
 *
 * 旧 ZCode agent 的 MCP/plugin/workflow/CUA API 不在此适配；对应调用方必须在阶段 3 删除。
 * 这里保留的是 nek 有真实 RPC 或 v4 投影事实的竖切路径。
 */
export class NekAgentServiceAdapter implements NekAgentServiceAdapterApi {
  readonly service: NekAgentService;
  private readonly topics: NekAgentServiceTopics;
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly conversationSubscriptions = new Map<string, ConversationSubscription>();
  private readonly conversationEmitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();

  constructor(options: NekAgentServiceAdapterOptions) {
    this.service = new NekAgentService(options);
    const syncer =
      options.sessionIndexSyncer ??
      new NekSessionIndexSyncer({ storage: new MemoryNekSessionIndexStorage(), listSessions: async (input) => await this.service.listSessions(input) });
    this.topics = new NekAgentServiceTopics(
      this.service,
      (target) => this.resolveSessionKey(target),
      syncer,
      options.maxV4Subscriptions,
    );
  }

  async initialize(target: NekWorkspaceTarget): Promise<{ available: boolean; workspaceKey: string }> {
    if (!target.workspacePath) throw new Error("workspacePath is required");
    return { available: true, workspaceKey: workspaceKey(target) };
  }

  async createSession(input: {
    workspacePath: string;
    sessionId?: string;
    model?: { provider: string; modelId: string };
    thinking?: NekThinkingLevel;
    mode?: NekMode;
  }): Promise<NekSessionResult> {
    if (input.sessionId) throw new Error("nek creates session ids; caller cannot supply sessionId");
    const target = { workspacePath: input.workspacePath };
    const result = await this.service.createSession({
      cwd: input.workspacePath,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
    });
    this.bind(target, result);
    return result;
  }

  async resumeSession(input: {
    workspacePath: string;
    sessionPath: string;
  }): Promise<NekSessionResult> {
    const target = { workspacePath: input.workspacePath };
    const result = await this.service.resumeSession({
      sessionPath: input.sessionPath,
      cwd: input.workspacePath,
    });
    this.bind(target, result);
    return result;
  }

  async listSessions(target: NekWorkspaceTarget): Promise<NekSessionSummary[]> {
    return await this.service.listSessions({ cwd: target.workspacePath });
  }

  async closeSession(input: NekWorkspaceTarget & { sessionId: string }): Promise<boolean> {
    const binding = this.requireBinding(input, input.sessionId);
    const result = await this.service.closeSession(binding.sessionKey);
    this.bindings.delete(sessionMapKey(input, input.sessionId));
    return result;
  }

  async readSession(input: NekWorkspaceTarget & { sessionId: string }): Promise<ConversationSnapshot> {
    const binding = this.requireBinding(input, input.sessionId);
    return this.service.conversationSnapshot(binding.sessionKey);
  }

  async readSessionMessages(
    target: NekWorkspaceTarget & { sessionId: string },
  ): Promise<NekAgentMessage[]> {
    const binding = this.requireBinding(target, target.sessionId);
    return await this.service.readSessionMessages(binding.sessionKey);
  }

  async subscribeConversationV4(
    input: NekConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult> {
    this.assertSubscriptionCapacity();
    const binding = this.requireBinding(input, input.sessionId);
    const id = makeSubscriptionId(`conversation/${input.sessionId}`);
    const topic = `conversation/${input.sessionId}`;
    let firstFrame: ConversationTopicFrame | undefined;
    let ordinal = 0;
    let first = true;
    const subscription: ConversationSubscription = {
      id,
      workspaceKey: workspaceKey(input),
      sessionKey: binding.sessionKey,
      topic,
      ordinal: 0,
      detach: () => {},
    };
    const detach = await this.service.subscribeConversation(binding.sessionKey, (frame) => {
      firstFrame ??= frame;
      const mapped = makeWireFrame({ ...frame, topic }, id, ++ordinal, first ? "initial" : "online");
      first = false;
      this.conversationEmitter(subscription.workspaceKey).fire(mapped);
    });
    subscription.detach = detach;
    subscription.ordinal = ordinal;
    this.conversationSubscriptions.set(id, subscription);
    return {
      ack: {
        subscriptionId: id,
        mode: "snapshot",
        logEpoch:
          firstFrame?.payload.kind === "snapshot" ? firstFrame.payload.snapshot.logEpoch : "nek-1",
      },
    };
  }

  async resyncConversationV4(input: NekConversationResyncParams): Promise<V4ConversationResyncResult> {
    const subscription = this.conversationSubscriptions.get(input.subscriptionId);
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
    subscription.ordinal += 1;
    this.conversationEmitter(subscription.workspaceKey).fire(
      makeWireFrame(frame, subscription.id, subscription.ordinal, "recovery"),
    );
    return { ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch: snapshot.logEpoch } };
  }

  async unsubscribeConversationV4(input: NekConversationUnsubscribeParams): Promise<void> {
    const subscription = this.conversationSubscriptions.get(input.subscriptionId);
    if (!subscription) return;
    subscription.detach();
    this.conversationSubscriptions.delete(input.subscriptionId);
  }

  onDynamicConversationFrame(target: NekWorkspaceTarget): Event<ConversationTopicWireCandidate> {
    return this.conversationEmitter(workspaceKey(target)).event;
  }

  async subscribeSessionsIndexV4(input: Parameters<NekAgentServiceTopics["subscribeSessionsIndexV4"]>[0]) {
    return await this.topics.subscribeSessionsIndexV4(input);
  }

  async resyncSessionsIndexV4(input: Parameters<NekAgentServiceTopics["resyncSessionsIndexV4"]>[0]) {
    return await this.topics.resyncSessionsIndexV4(input);
  }

  async unsubscribeSessionsIndexV4(input: Parameters<NekAgentServiceTopics["unsubscribeSessionsIndexV4"]>[0]): Promise<void> {
    await this.topics.unsubscribeSessionsIndexV4(input);
  }

  onDynamicSessionsIndexFrame(input: NekWorkspaceTarget) {
    return this.topics.onDynamicSessionsIndexFrame(input);
  }

  async subscribeWorkspaceConfigV4(input: NekWorkspaceConfigSubscribeParams) {
    return await this.topics.subscribeWorkspaceConfigV4(input);
  }

  async resyncWorkspaceConfigV4(input: Parameters<NekAgentServiceTopics["resyncWorkspaceConfigV4"]>[0]) {
    return await this.topics.resyncWorkspaceConfigV4(input);
  }

  async unsubscribeWorkspaceConfigV4(input: Parameters<NekAgentServiceTopics["unsubscribeWorkspaceConfigV4"]>[0]): Promise<void> {
    await this.topics.unsubscribeWorkspaceConfigV4(input);
  }

  onDynamicWorkspaceConfigFrame(input: NekWorkspaceTarget) {
    return this.topics.onDynamicWorkspaceConfigFrame(input);
  }

  async sendConversationCommandV4(input: {
    target: NekWorkspaceTarget;
    envelope: NekSessionCommandEnvelope;
  }): Promise<CommandAck> {
    const { envelope } = input;
    const payload = asRecord(envelope.payload) ?? {};
    if (envelope.type === "createSession") return await this.createFromCommand(input.target, envelope, payload);
    if (!envelope.sessionId) return unsupportedCommand(envelope, "sessionId is required");
    const binding = this.requireBinding(input.target, envelope.sessionId);
    const revision = this.service.conversationSnapshot(binding.sessionKey).revision;
    switch (envelope.type) {
      case "sendText": {
        await this.applySelection(binding.sessionKey, payload);
        const images = await toNekImages(payload.attachments);
        const requestedDelivery = readString(payload, "requestedDelivery");
        const result = await this.service.sendPrompt({
          sessionKey: binding.sessionKey,
          message: readString(payload, "text") ?? "",
          ...(images ? { images } : {}),
          ...(requestedDelivery === "queue" ? { streamingBehavior: "follow_up" as const } : {}),
        });
        return acceptedCommand(envelope, revision, {
          type: "inputAccepted",
          delivery: result.disposition === "started" ? "startNow" : "queue",
          inputId: envelope.commandId,
        });
      }
      case "sendGoalCommand": {
        await this.applySelection(binding.sessionKey, payload);
        const result = await this.service.sendPrompt({
          sessionKey: binding.sessionKey,
          message: readString(payload, "text") ?? "",
        });
        return acceptedCommand(envelope, revision, {
          type: "inputAccepted",
          delivery: result.disposition === "started" ? "startNow" : "queue",
          inputId: envelope.commandId,
        });
      }
      case "stop":
        await this.service.abort(binding.sessionKey);
        return acceptedCommand(envelope, revision);
      case "compact":
        await this.service.compact({ sessionKey: binding.sessionKey });
        return acceptedCommand(envelope, revision);
      case "switchModelConfig":
        await this.service.setModel({
          sessionKey: binding.sessionKey,
          provider: readString(payload, "provider") ?? "",
          modelId: readString(payload, "model") ?? "",
        });
        await this.setThoughtFromPayload(binding.sessionKey, payload);
        return acceptedCommand(envelope, revision);
      case "switchCollaborationMode":
        await this.setModeFromPayload(binding.sessionKey, payload);
        return acceptedCommand(envelope, revision);
      case "setFollowupMode":
        await this.service.setFollowUpMode(
          binding.sessionKey,
          readString(payload, "mode") === "guide" ? "all" : "one-at-a-time",
        );
        return acceptedCommand(envelope, revision);
      case "renameSession":
        await this.service.renameSession({
          sessionKey: binding.sessionKey,
          name: readString(payload, "title") ?? "",
        });
        return acceptedCommand(envelope, revision);
      case "deleteSession":
        await this.service.deleteSession({ sessionKey: binding.sessionKey });
        this.bindings.delete(sessionMapKey(input.target, envelope.sessionId));
        return acceptedCommand(envelope, revision);
      default:
        return unsupportedCommand(envelope, "the corresponding nek RPC does not exist");
    }
  }

  async queryConversationCommandsV4(input: {
    target: NekWorkspaceTarget;
    commands: Array<{ sessionId: string | null; commandId: string }>;
    clock?: true;
  }): Promise<CommandsQueryResult> {
    if (input.clock) {
      return {
        results: input.commands.map((key) => ({ key, result: "unknown" as const })),
        clock: { instanceId: `nek:${workspaceKey(input.target)}`, receivedAt: Date.now(), sentAt: Date.now() },
      };
    }
    for (const command of input.commands) {
      if (command.sessionId) {
        const binding = this.requireBinding(input.target, command.sessionId);
        await this.service.getCommands(binding.sessionKey);
      }
    }
    return { results: input.commands.map((key) => ({ key, result: "unknown" as const })) };
  }

  async dispose(): Promise<void> {
    for (const subscription of this.conversationSubscriptions.values()) subscription.detach();
    this.conversationSubscriptions.clear();
    for (const emitter of this.conversationEmitters.values()) emitter.dispose();
    this.conversationEmitters.clear();
    await this.topics.dispose();
    this.bindings.clear();
    await this.service.dispose();
  }

  resolveSessionKey(target: NekWorkspaceTarget, sessionId?: string): string | undefined {
    if (sessionId) return this.bindings.get(sessionMapKey(target, sessionId))?.sessionKey;
    const candidate = [...this.bindings.values()].find(
      (binding) => binding.target.workspacePath === target.workspacePath,
    );
    return candidate?.sessionKey;
  }

  private async createFromCommand(
    target: NekWorkspaceTarget,
    envelope: NekSessionCommandEnvelope,
    payload: Record<string, unknown>,
  ): Promise<CommandAck> {
    const firstInput = asRecord(payload.firstInput);
    const config = asRecord(payload.config);
    const model = asRecord(firstInput?.modelSelection ?? config?.modelSelection);
    const result = await this.createSession({
      workspacePath: target.workspacePath,
      ...(model
        ? {
            model: {
              provider: readString(model, "provider") ?? "",
              modelId: readString(model, "modelId") ?? "",
            },
          }
        : {}),
      ...(readString(config ?? {}, "thought") ? { thinking: this.thoughtLevel(readString(config ?? {}, "thought")) } : {}),
      ...(readString(config ?? {}, "mode") ? { mode: this.mode(readString(config ?? {}, "mode")) } : {}),
    });
    if (firstInput) {
      await this.service.sendPrompt({
        sessionKey: result.sessionKey,
        message: readString(firstInput, "text") ?? "",
        images: await toNekImages(firstInput.attachments),
      });
    }
    return acceptedCommand(envelope, result.conversation.revision, {
      type: "createSession",
      sessionId: result.sessionId,
      ...(firstInput ? { input: { delivery: "startNow", inputId: envelope.commandId } } : {}),
    });
  }

  private async applySelection(sessionKey: string, payload: Record<string, unknown>): Promise<void> {
    const model = asRecord(payload.modelSelection);
    if (model) {
      await this.service.setModel({
        sessionKey,
        provider: readString(model, "provider") ?? "",
        modelId: readString(model, "modelId") ?? "",
      });
    }
    const mode = readString(payload, "mode");
    if (mode) await this.setModeFromPayload(sessionKey, payload);
  }

  private async setModeFromPayload(sessionKey: string, payload: Record<string, unknown>): Promise<void> {
    await this.service.setMode({ sessionKey, mode: this.mode(readString(payload, "mode")) });
  }

  private async setThoughtFromPayload(sessionKey: string, payload: Record<string, unknown>): Promise<void> {
    await this.service.setThinkingLevel({
      sessionKey,
      level: this.thoughtLevel(readString(payload, "thought")),
    });
  }

  private mode(value: string | undefined): NekMode {
    if (value === "agent" || value === "plan") return value;
    throw new Error(`invalid nek mode: ${value ?? "missing"}`);
  }

  private thoughtLevel(value: string | undefined): NekThinkingLevel {
    if (value && THOUGHT_LEVELS.includes(value as NekThinkingLevel)) return value as NekThinkingLevel;
    throw new Error(`invalid nek thinking level: ${value ?? "missing"}`);
  }

  private bind(target: NekWorkspaceTarget, result: NekSessionResult): void {
    if (this.bindings.size >= MAX_BINDINGS) throw new Error(`nek session binding limit exceeded (${MAX_BINDINGS})`);
    this.bindings.set(sessionMapKey(target, result.sessionId), {
      target,
      sessionKey: result.sessionKey,
      sessionId: result.sessionId,
      ...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
    });
  }

  private requireBinding(target: NekWorkspaceTarget, sessionId: string): SessionBinding {
    const direct = this.bindings.get(sessionMapKey(target, sessionId));
    if (direct) return direct;
    const binding = [...this.bindings.values()].find(
      (candidate) =>
        candidate.target.workspacePath === target.workspacePath && candidate.sessionId === sessionId,
    );
    if (!binding) throw new Error(`nek session ${sessionId} is not open in ${target.workspacePath}`);
    return binding;
  }

  private assertSubscriptionCapacity(): void {
    if (this.conversationSubscriptions.size >= 128) throw new Error("nek conversation subscription limit exceeded (128)");
  }

  private conversationEmitter(workspace: string): Emitter<ConversationTopicWireCandidate> {
    let emitter = this.conversationEmitters.get(workspace);
    if (!emitter) {
      emitter = new Emitter<ConversationTopicWireCandidate>();
      this.conversationEmitters.set(workspace, emitter);
    }
    return emitter;
  }
}

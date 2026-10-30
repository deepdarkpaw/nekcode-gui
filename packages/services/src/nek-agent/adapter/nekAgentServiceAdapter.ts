import { Emitter, type Event } from "@zcode/rpc";
import type {
  NekAgentMessage,
  NekInteractionFrame,
  NekMode,
  NekSessionStats,
  NekSessionSummary,
  NekStatusFrame,
  NekStatusQueue,
  NekStatusSnapshot,
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
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import { NekAgentService } from "../service/nekAgentService.js";
import type { NekSessionResult } from "../service/types.js";
import { makeSubscriptionId, makeWireFrame, sessionMapKey, workspaceKey } from "./frameHelpers.js";
import { sendConversationCommand } from "./nekAgentServiceAdapterCommands.js";
import { createNekLegacyMethods } from "./nekAgentServiceAdapterLegacy.js";
import { NekAgentInteractionChannel } from "./nekAgentInteractionChannel.js";
import { NekAgentStatusChannel } from "./nekAgentStatusChannel.js";
import { NekAgentServiceTopics } from "./nekAgentServiceTopics.js";
import type {
  NekAgentServiceAdapterApi,
  NekAgentServiceAdapterOptions,
  NekConversationResyncParams,
  NekConversationSubscribeParams,
  NekConversationUnsubscribeParams,
  NekSessionBinding,
  NekSessionCommandEnvelope,
  NekWorkspaceConfigSubscribeParams,
  NekWorkspaceTarget,
} from "./types.js";

interface ConversationSubscription {
  id: string;
  workspaceKey: string;
  sessionKey: string;
  topic: string;
  ordinal: number;
  detach: () => void;
}

const MAX_BINDINGS = 5_000;

/**
 * 把 NekAgentService 接到现有 ZCode v4 host 面。
 *
 * 旧 ZCode agent 的 MCP/plugin/workflow/CUA API 不在此适配；对应调用方必须在阶段 3 删除。
 * 这里保留的是 nek 有真实 RPC 或 v4 投影事实的竖切路径。
 */
export class NekAgentServiceAdapter implements IZCodeAgentService, NekAgentServiceAdapterApi {
  declare readonly prepareStorage: IZCodeAgentService["prepareStorage"];
  declare readonly getStorageStartupState: IZCodeAgentService["getStorageStartupState"];
  declare readonly onDynamicStorageStartupState: IZCodeAgentService["onDynamicStorageStartupState"];
  declare readonly syncAppRuntimePreferences: IZCodeAgentService["syncAppRuntimePreferences"];
  declare readonly getWorkspaceRuntimeIdentity: IZCodeAgentService["getWorkspaceRuntimeIdentity"];
  declare readonly createSession: IZCodeAgentService["createSession"];
  declare readonly resumeSession: IZCodeAgentService["resumeSession"];
  declare readonly listSessions: IZCodeAgentService["listSessions"];
  declare readonly listSessionSubagents: IZCodeAgentService["listSessionSubagents"];
  declare readonly stopSubagent: IZCodeAgentService["stopSubagent"];
  declare readonly getSubagentTranscript: IZCodeAgentService["getSubagentTranscript"];
  declare readonly listAgentTypes: IZCodeAgentService["listAgentTypes"];
  declare readonly getTaskTokenUsage: IZCodeAgentService["getTaskTokenUsage"];
  declare readonly readSession: IZCodeAgentService["readSession"];
  declare readonly readSessionMessages: IZCodeAgentService["readSessionMessages"];
  declare readonly readSessionDebug: IZCodeAgentService["readSessionDebug"];
  declare readonly readSessionEvents: IZCodeAgentService["readSessionEvents"];
  declare readonly readWorkspacePresentation: IZCodeAgentService["readWorkspacePresentation"];
  declare readonly grantWorkspaceHookTrust: IZCodeAgentService["grantWorkspaceHookTrust"];
  declare readonly listMcpServerStatuses: IZCodeAgentService["listMcpServerStatuses"];
  declare readonly getSkillReferenceCatalog: IZCodeAgentService["getSkillReferenceCatalog"];
  declare readonly collectLocalRuntimeChildProcesses: IZCodeAgentService["collectLocalRuntimeChildProcesses"];
  declare readonly generateWorkspaceText: IZCodeAgentService["generateWorkspaceText"];
  declare readonly testModelConnectivity: IZCodeAgentService["testModelConnectivity"];
  declare readonly sendPrompt: IZCodeAgentService["sendPrompt"];
  declare readonly compactSession: IZCodeAgentService["compactSession"];
  declare readonly goalSession: IZCodeAgentService["goalSession"];
  declare readonly closeSession: IZCodeAgentService["closeSession"];
  declare readonly setModel: IZCodeAgentService["setModel"];
  declare readonly setThoughtLevel: IZCodeAgentService["setThoughtLevel"];
  declare readonly setMode: IZCodeAgentService["setMode"];
  declare readonly respondSessionRuntimePreferences: IZCodeAgentService["respondSessionRuntimePreferences"];
  declare readonly onDynamicSessionRuntimePreferencesRequest: IZCodeAgentService["onDynamicSessionRuntimePreferencesRequest"];
  declare readonly onDynamicProcessResourceSample: IZCodeAgentService["onDynamicProcessResourceSample"];
  declare readonly onDynamicMcpTelemetry: IZCodeAgentService["onDynamicMcpTelemetry"];
  declare readonly onDynamicMcpResourceSamples: IZCodeAgentService["onDynamicMcpResourceSamples"];
  declare readonly onDynamicToolExecResource: IZCodeAgentService["onDynamicToolExecResource"];
  declare readonly onDynamicSessionEvent: IZCodeAgentService["onDynamicSessionEvent"];
  declare readonly helloConversationV4: IZCodeAgentService["helloConversationV4"];
  declare readonly initializeConversationV4: IZCodeAgentService["initializeConversationV4"];
  declare readonly setConnectionFlowStateV4: IZCodeAgentService["setConnectionFlowStateV4"];
  declare readonly conversationRowsRangeV4: IZCodeAgentService["conversationRowsRangeV4"];
  declare readonly conversationPlansV4: IZCodeAgentService["conversationPlansV4"];
  declare readonly backgroundBashOutputV4: IZCodeAgentService["backgroundBashOutputV4"];
  declare readonly conversationFileChangesV4: IZCodeAgentService["conversationFileChangesV4"];
  declare readonly conversationFileRewindPreviewV4: IZCodeAgentService["conversationFileRewindPreviewV4"];
  declare readonly sendConversationCommandV4: IZCodeAgentService["sendConversationCommandV4"];
  declare readonly queryConversationCommandsV4: IZCodeAgentService["queryConversationCommandsV4"];
  declare readonly attachmentBeginV4: IZCodeAgentService["attachmentBeginV4"];
  declare readonly attachmentChunkV4: IZCodeAgentService["attachmentChunkV4"];
  declare readonly attachmentCommitV4: IZCodeAgentService["attachmentCommitV4"];
  declare readonly attachmentAbortV4: IZCodeAgentService["attachmentAbortV4"];
  declare readonly attachmentPreviewSourceV4: IZCodeAgentService["attachmentPreviewSourceV4"];
  declare readonly attachmentReadV4: IZCodeAgentService["attachmentReadV4"];
  declare readonly conversationAttachmentReadV4: IZCodeAgentService["conversationAttachmentReadV4"];
  declare readonly conversationAttachmentStatV4: IZCodeAgentService["conversationAttachmentStatV4"];
  declare readonly onDynamicDiagnostic: IZCodeAgentService["onDynamicDiagnostic"];
  declare readonly onDynamicSessionActivity: IZCodeAgentService["onDynamicSessionActivity"];
  declare readonly onDynamicLocalTtftFacts: IZCodeAgentService["onDynamicLocalTtftFacts"];
  declare readonly onDynamicConversationTelemetryFact: IZCodeAgentService["onDynamicConversationTelemetryFact"];
  declare readonly onAgentRuntimeRestarted: IZCodeAgentService["onAgentRuntimeRestarted"];
  declare readonly disposeWorkspace: IZCodeAgentService["disposeWorkspace"];
  declare readonly disposeAll: IZCodeAgentService["disposeAll"];
  readonly service: NekAgentService;
  private readonly topics: NekAgentServiceTopics;
  private readonly interactions: NekAgentInteractionChannel;
  private readonly status: NekAgentStatusChannel;
  private readonly bindings = new Map<string, NekSessionBinding>();
  private readonly conversationSubscriptions = new Map<string, ConversationSubscription>();
  private readonly conversationEmitters = new Map<
    string,
    Emitter<ConversationTopicWireCandidate>
  >();

  constructor(options: NekAgentServiceAdapterOptions) {
    this.service = new NekAgentService(options);
    const syncer =
      options.sessionIndexSyncer ??
      new NekSessionIndexSyncer({
        storage: new MemoryNekSessionIndexStorage(),
        listSessions: async (input) => await this.service.listSessions(input),
      });
    this.topics = new NekAgentServiceTopics(
      this.service,
      (target) => this.resolveSessionKey(target),
      syncer,
      options.maxV4Subscriptions,
    );
    this.interactions = new NekAgentInteractionChannel(this.service);
    this.status = new NekAgentStatusChannel(this.service, options.logger);
    Object.assign(this, createNekLegacyMethods(this));
  }

  async initialize(
    target: NekWorkspaceTarget,
  ): Promise<{ available: boolean; workspaceKey: string }> {
    if (!target.workspacePath) throw new Error("workspacePath is required");
    return { available: true, workspaceKey: workspaceKey(target) };
  }

  async createNekSession(input: {
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
    this.status.publish(target, result.sessionKey);
    return result;
  }

  async resumeNekSession(input: {
    workspacePath: string;
    sessionPath: string;
  }): Promise<NekSessionResult> {
    const target = { workspacePath: input.workspacePath };
    const result = await this.service.resumeSession({
      sessionPath: input.sessionPath,
      cwd: input.workspacePath,
    });
    this.bind(target, result);
    this.status.publish(target, result.sessionKey);
    return result;
  }

  async listNekSessions(target: NekWorkspaceTarget): Promise<NekSessionSummary[]> {
    return await this.service.listSessions({ cwd: target.workspacePath });
  }

  async closeNekSession(input: NekWorkspaceTarget & { sessionId: string }): Promise<boolean> {
    const binding = this.requireBinding(input, input.sessionId);
    const result = await this.service.closeSession(binding.sessionKey);
    this.bindings.delete(sessionMapKey(input, input.sessionId));
    return result;
  }

  async readNekSession(
    input: NekWorkspaceTarget & { sessionId: string },
  ): Promise<ConversationSnapshot> {
    const binding = this.requireBinding(input, input.sessionId);
    return this.service.conversationSnapshot(binding.sessionKey);
  }

  async readNekSessionMessages(
    target: NekWorkspaceTarget & { sessionId: string },
  ): Promise<NekAgentMessage[]> {
    const binding = this.requireBinding(target, target.sessionId);
    const session = this.service.getSession(binding.sessionKey);
    if (session?.readonly) return (session.snapshot?.messages ?? []) as NekAgentMessage[];
    return (
      await this.service
        .commandContext()
        .target(binding.sessionKey)
        .client.call({ type: "get_messages" })
    ).messages;
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
    subscription.detach = await this.service.subscribeConversation(binding.sessionKey, (frame) => {
      firstFrame ??= frame;
      const mapped = makeWireFrame(
        { ...frame, topic },
        id,
        ++ordinal,
        first ? "initial" : "online",
      );
      first = false;
      this.conversationEmitter(subscription.workspaceKey).fire(mapped);
    });
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

  async resyncConversationV4(
    input: NekConversationResyncParams,
  ): Promise<V4ConversationResyncResult> {
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
    return {
      ack: { subscriptionId: subscription.id, mode: "snapshot", logEpoch: snapshot.logEpoch },
    };
  }

  async unsubscribeConversationV4(input: NekConversationUnsubscribeParams): Promise<void> {
    const subscription = this.conversationSubscriptions.get(input.subscriptionId);
    if (!subscription) return;
    subscription.detach();
    this.conversationSubscriptions.delete(input.subscriptionId);
  }

  onDynamicNekInteractionFrame = (target: NekWorkspaceTarget): Event<NekInteractionFrame> =>
    this.interactions.onDynamic(target);

  respondNekInteraction = async (
    input: Parameters<IZCodeAgentService["respondNekInteraction"]>[0],
  ): Promise<void> => await this.interactions.respond(input.response);

  // nek status feed
  onDynamicNekStatusFrame = (target: NekWorkspaceTarget): Event<NekStatusFrame> =>
    this.status.onDynamic(target);

  getNekStatusSnapshot = async (
    input: Parameters<IZCodeAgentService["getNekStatusSnapshot"]>[0],
  ): Promise<NekStatusSnapshot> => {
    const binding = this.requireBinding(input, input.sessionId);
    return await this.service.getStatusSnapshot(binding.sessionKey);
  };

  getNekSessionStats = async (
    input: Parameters<IZCodeAgentService["getNekSessionStats"]>[0],
  ): Promise<NekSessionStats> => {
    const binding = this.requireBinding(input, input.sessionId);
    return await this.service.getStats(binding.sessionKey);
  };

  clearNekQueue = async (
    input: Parameters<IZCodeAgentService["clearNekQueue"]>[0],
  ): Promise<NekStatusQueue> => {
    const binding = this.requireBinding(input, input.sessionId);
    return await this.service.clearQueue(binding.sessionKey);
  };

  requeueNekQueue = async (
    input: Parameters<IZCodeAgentService["requeueNekQueue"]>[0],
  ): Promise<void> => {
    const binding = this.requireBinding(input, input.sessionId);
    await this.service.requeueStatusQueue(binding.sessionKey, input.queue);
  };

  abortNekRetry = async (
    input: Parameters<IZCodeAgentService["abortNekRetry"]>[0],
  ): Promise<void> => {
    const binding = this.requireBinding(input, input.sessionId);
    await this.service.abortRetry(binding.sessionKey);
  };

  abortNekCompaction = async (
    input: Parameters<IZCodeAgentService["abortNekCompaction"]>[0],
  ): Promise<void> => {
    const binding = this.requireBinding(input, input.sessionId);
    await this.service.abortCompaction(binding.sessionKey);
  };

  compactNekSession = async (
    input: Parameters<IZCodeAgentService["compactNekSession"]>[0],
  ): Promise<void> => {
    const binding = this.requireBinding(input, input.sessionId);
    await this.service.compactStatus(binding.sessionKey);
  };

  onDynamicConversationFrame(target: NekWorkspaceTarget): Event<ConversationTopicWireCandidate> {
    return this.conversationEmitter(workspaceKey(target)).event;
  }

  async subscribeSessionsIndexV4(
    input: Parameters<NekAgentServiceTopics["subscribeSessionsIndexV4"]>[0],
  ) {
    return await this.topics.subscribeSessionsIndexV4(input);
  }

  async resyncSessionsIndexV4(
    input: Parameters<NekAgentServiceTopics["resyncSessionsIndexV4"]>[0],
  ) {
    return await this.topics.resyncSessionsIndexV4(input);
  }

  async unsubscribeSessionsIndexV4(
    input: Parameters<NekAgentServiceTopics["unsubscribeSessionsIndexV4"]>[0],
  ): Promise<void> {
    await this.topics.unsubscribeSessionsIndexV4(input);
  }

  onDynamicSessionsIndexFrame(input: NekWorkspaceTarget) {
    return this.topics.onDynamicSessionsIndexFrame(input);
  }

  async subscribeWorkspaceConfigV4(input: NekWorkspaceConfigSubscribeParams) {
    return await this.topics.subscribeWorkspaceConfigV4(input);
  }

  async resyncWorkspaceConfigV4(
    input: Parameters<NekAgentServiceTopics["resyncWorkspaceConfigV4"]>[0],
  ) {
    return await this.topics.resyncWorkspaceConfigV4(input);
  }

  async unsubscribeWorkspaceConfigV4(
    input: Parameters<NekAgentServiceTopics["unsubscribeWorkspaceConfigV4"]>[0],
  ): Promise<void> {
    await this.topics.unsubscribeWorkspaceConfigV4(input);
  }

  onDynamicWorkspaceConfigFrame(input: NekWorkspaceTarget) {
    return this.topics.onDynamicWorkspaceConfigFrame(input);
  }

  async sendNekConversationCommandV4(input: {
    target: NekWorkspaceTarget;
    envelope: NekSessionCommandEnvelope;
  }): Promise<CommandAck> {
    return await sendConversationCommand(
      {
        service: this.service,
        createSession: async (request) => await this.createNekSession(request),
        requireBinding: (target, sessionId) => this.requireBinding(target, sessionId),
        removeBinding: (target, sessionId) => {
          this.bindings.delete(sessionMapKey(target, sessionId));
        },
      },
      input,
    );
  }

  async queryNekConversationCommandsV4(input: {
    target: NekWorkspaceTarget;
    commands: Array<{ sessionId: string | null; commandId: string }>;
    clock?: true;
  }): Promise<CommandsQueryResult> {
    if (input.clock) {
      const now = Date.now();
      return {
        results: input.commands.map((key) => ({ key, result: "unknown" as const })),
        clock: { instanceId: `nek:${workspaceKey(input.target)}`, receivedAt: now, sentAt: now },
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
    this.interactions.dispose();
    this.status.dispose();
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

  private bind(target: NekWorkspaceTarget, result: NekSessionResult): void {
    if (this.bindings.size >= MAX_BINDINGS)
      throw new Error(`nek session binding limit exceeded (${MAX_BINDINGS})`);
    this.bindings.set(sessionMapKey(target, result.sessionId), {
      target,
      sessionKey: result.sessionKey,
      sessionId: result.sessionId,
      ...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
    });
  }

  private requireBinding(target: NekWorkspaceTarget, sessionId: string): NekSessionBinding {
    const direct = this.bindings.get(sessionMapKey(target, sessionId));
    if (direct) return direct;
    const binding = [...this.bindings.values()].find(
      (candidate) =>
        candidate.target.workspacePath === target.workspacePath &&
        candidate.sessionId === sessionId,
    );
    if (!binding)
      throw new Error(`nek session ${sessionId} is not open in ${target.workspacePath}`);
    return binding;
  }

  private assertSubscriptionCapacity(): void {
    if (this.conversationSubscriptions.size >= 128)
      throw new Error("nek conversation subscription limit exceeded (128)");
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

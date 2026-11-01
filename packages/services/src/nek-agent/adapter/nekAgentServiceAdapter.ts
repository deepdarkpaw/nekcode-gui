import type { Event } from "@zcode/rpc";
import type {
  NekAgentMessage,
  NekInteractionFrame,
  NekMode,
  NekSessionSummary,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import type {
  CommandAck,
  CommandsQueryResult,
  ConversationSnapshot,
  ConversationTopicWireCandidate,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { NekSessionBindings } from "./nekSessionBindings.js";
import { NekSessionIndexSyncer } from "../index/nekSessionIndexSyncer.js";
import { MemoryNekSessionIndexStorage } from "../index/nekSessionIndexStorage.js";
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import { NekAgentService } from "../service/nekAgentService.js";
import type { NekSessionResult } from "../service/types.js";
import { workspaceKey } from "./frameHelpers.js";
import { NekConversationSubscriptions } from "./nekConversationSubscriptions.js";
import {
  queryConversationCommands,
  sendConversationCommand,
} from "./nekAgentServiceAdapterCommands.js";
import { createNekLegacyMethods } from "./nekAgentServiceAdapterLegacy.js";
import { NekAgentInteractionChannel } from "./nekAgentInteractionChannel.js";
import type { NekAgentStatusChannel } from "./nekAgentStatusChannel.js";
import { createNekAgentStatusFeed, type NekAgentStatusMethods } from "./nekAgentStatusMethods.js";
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
  /** 应用退出：`disposeServiceResourcesAndWait` 等待 nek 进程关闭与未用会话清理完成。 */
  declare readonly disposeAllAndWait: () => Promise<void>;
  // nek status feed（薄壳实现见 nekAgentStatusMethods.ts，经 Object.assign 挂上）
  declare readonly onDynamicNekStatusFrame: NekAgentStatusMethods["onDynamicNekStatusFrame"];
  declare readonly getNekStatusSnapshot: NekAgentStatusMethods["getNekStatusSnapshot"];
  declare readonly getNekSessionStats: NekAgentStatusMethods["getNekSessionStats"];
  declare readonly clearNekQueue: NekAgentStatusMethods["clearNekQueue"];
  declare readonly requeueNekQueue: NekAgentStatusMethods["requeueNekQueue"];
  declare readonly abortNekRetry: NekAgentStatusMethods["abortNekRetry"];
  declare readonly abortNekCompaction: NekAgentStatusMethods["abortNekCompaction"];
  declare readonly abortNekSession: NekAgentStatusMethods["abortNekSession"];
  declare readonly compactNekSession: NekAgentStatusMethods["compactNekSession"];
  readonly service: NekAgentService;
  readonly logger: NekAgentServiceAdapterOptions["logger"];
  private readonly topics: NekAgentServiceTopics;
  private readonly interactions: NekAgentInteractionChannel;
  private readonly status: NekAgentStatusChannel;
  private readonly bindings: NekSessionBindings;
  private readonly conversations: NekConversationSubscriptions;
  private disposed = false;

  constructor(options: NekAgentServiceAdapterOptions) {
    this.service = new NekAgentService(options);
    this.logger = options.logger;
    this.bindings = new NekSessionBindings({
      getSession: (key) => this.service.getSession(key),
      listSessions: (target) => this.listNekSessions(target),
      resumeSession: (input) => this.resumeNekSession(input),
    });
    const syncer =
      options.sessionIndexSyncer ??
      new NekSessionIndexSyncer({
        storage: new MemoryNekSessionIndexStorage(),
        listSessions: async (input) => await this.service.listSessions(input),
      });
    this.conversations = new NekConversationSubscriptions(this.service, (target, sessionId) =>
      this.ensureNekSessionBinding(target, sessionId, true),
    );
    this.topics = new NekAgentServiceTopics(
      this.service,
      (target) => this.resolveSessionKey(target),
      syncer,
      options.maxV4Subscriptions,
    );
    this.interactions = new NekAgentInteractionChannel(this.service);
    const statusFeed = createNekAgentStatusFeed(this, options.logger);
    this.status = statusFeed.channel;
    Object.assign(this, statusFeed.methods, createNekLegacyMethods(this));
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
    this.bindings.bind(target, result);
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
    this.bindings.bind(target, result);
    this.status.publish(target, result.sessionKey);
    return result;
  }

  async listNekSessions(target: NekWorkspaceTarget): Promise<NekSessionSummary[]> {
    return await this.service.listSessions({ cwd: target.workspacePath });
  }

  async ensureNekSessionBinding(
    target: NekWorkspaceTarget,
    sessionId: string,
    refreshLocked = false,
  ): Promise<NekSessionBinding> {
    return await this.bindings.ensure(target, sessionId, refreshLocked);
  }

  async closeNekSession(input: NekWorkspaceTarget & { sessionId: string }): Promise<boolean> {
    await this.bindings.waitForPending(input, input.sessionId);
    const binding = this.bindings.require(input, input.sessionId);
    const result = await this.service.closeSession(binding.sessionKey);
    this.bindings.remove(input, input.sessionId);
    // nek status feed：会话关闭后 renderer 必须丢掉本地状态，不能继续显示上一次的行。
    this.status.publishClosed(binding.target, binding.sessionId);
    return result;
  }

  async readNekSession(
    input: NekWorkspaceTarget & { sessionId: string },
  ): Promise<ConversationSnapshot> {
    const binding = await this.ensureNekSessionBinding(input, input.sessionId);
    return this.service.conversationSnapshot(binding.sessionKey);
  }

  async readNekSessionMessages(
    target: NekWorkspaceTarget & { sessionId: string },
  ): Promise<NekAgentMessage[]> {
    const binding = await this.ensureNekSessionBinding(target, target.sessionId);
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
    return await this.conversations.subscribe(input);
  }

  async resyncConversationV4(
    input: NekConversationResyncParams,
  ): Promise<V4ConversationResyncResult> {
    return await this.conversations.resync(input);
  }

  async unsubscribeConversationV4(input: NekConversationUnsubscribeParams): Promise<void> {
    this.conversations.unsubscribe(input);
  }

  onDynamicNekInteractionFrame = (target: NekWorkspaceTarget): Event<NekInteractionFrame> =>
    this.interactions.onDynamic(target);

  respondNekInteraction = async (
    input: Parameters<IZCodeAgentService["respondNekInteraction"]>[0],
  ): Promise<void> => await this.interactions.respond(input.response);

  onDynamicConversationFrame(target: NekWorkspaceTarget): Event<ConversationTopicWireCandidate> {
    return this.conversations.onDynamicFrame(target);
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
        bindSession: (target, result) => {
          this.bindings.bind(target, result);
          this.status.publish(target, result.sessionKey);
        },
        ensureBinding: (target, sessionId) => this.ensureNekSessionBinding(target, sessionId),
        removeBinding: (target, sessionId) => this.bindings.remove(target, sessionId),
      },
      input,
    );
  }

  async queryNekConversationCommandsV4(input: {
    target: NekWorkspaceTarget;
    commands: Array<{ sessionId: string | null; commandId: string }>;
    clock?: true;
  }): Promise<CommandsQueryResult> {
    return await queryConversationCommands(
      {
        service: this.service,
        ensureBinding: (target, sessionId) => this.ensureNekSessionBinding(target, sessionId),
      },
      input,
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.bindings.dispose();
    this.conversations.dispose();
    this.interactions.dispose();
    this.status.dispose();
    await this.topics.dispose();
    await this.service.dispose();
  }

  resolveSessionKey(target: NekWorkspaceTarget, sessionId?: string): string | undefined {
    return this.bindings.resolve(target, sessionId);
  }
}

import type {
  ClientHello,
  V4ConversationPlansResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
} from "@zcode/shared/zcode-protocol-v4";
import { toNekImages } from "./attachmentImages.js";
import type { NekSessionCommandEnvelope } from "./types.js";
import {
  bindingSnapshot,
  emptyEvent,
  emptyHello,
  legacySessionInfo,
  legacySnapshotFromResult,
  type LegacyCompactResult,
  type LegacyMethods,
  type LegacyModeResult,
  type LegacyModelResult,
  type LegacySendResult,
  type LegacyThoughtResult,
  type NekAgentServiceAdapterLegacyTarget,
  unsupported,
} from "./nekAgentServiceAdapterLegacySupport.js";
import { workspaceKey } from "./frameHelpers.js";

export function createNekLegacyMethods(target: NekAgentServiceAdapterLegacyTarget): LegacyMethods {
  const methods: LegacyMethods = {
    async prepareStorage() {
      await target.service.commandContext().control();
    },
    async getStorageStartupState() {
      return null;
    },
    onDynamicStorageStartupState: emptyEvent,
    async syncAppRuntimePreferences() {
      return;
    },
    async getWorkspaceRuntimeIdentity(input) {
      return {
        generation: 1,
        identity: `nek:${workspaceKey(input)}`,
        workspaceKey: workspaceKey(input),
      };
    },
    async createSession(input) {
      const result = await target.createNekSession({
        workspacePath: input.workspacePath,
        ...(input.model
          ? { model: { provider: input.model.providerId, modelId: input.model.modelId } }
          : {}),
        ...(input.thoughtLevel ? { thinking: input.thoughtLevel as never } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      });
      return legacySnapshotFromResult(input, result, input.mode ?? "agent");
    },
    async resumeSession(input) {
      const summary = (await target.listNekSessions(input)).find(
        (item) => item.id === input.sessionId,
      );
      if (!summary) throw new Error(`nek session ${input.sessionId} was not found`);
      const result = await target.resumeNekSession({
        workspacePath: input.workspacePath,
        sessionPath: summary.path,
      });
      return legacySnapshotFromResult(input, result);
    },
    async listSessions(input) {
      const summaries = await target.listNekSessions(input);
      return summaries.map((summary) => legacySessionInfo(input, summary));
    },
    async listSessionSubagents() {
      return { revision: 0, childSessionIds: [], running: [], ended: { total: 0, items: [] } };
    },
    async getTaskTokenUsage(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      const stats = await target.service.getStats(sessionKey);
      return {
        sessionId: input.sessionId,
        totalTokens: stats.tokens.total,
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        reasoningTokens: 0,
        cacheCreationTokens: stats.tokens.cacheWrite,
        cacheReadTokens: stats.tokens.cacheRead,
        modelRequestCount: stats.assistantMessages,
        modelErrorCount: 0,
        inputBaselineBySource: {},
      };
    },
    async readSession(input) {
      return await bindingSnapshot(target, input);
    },
    async readSessionMessages(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      return [];
    },
    async readSessionDebug(input) {
      return { sessionId: input.sessionId, rounds: [], networkEntries: [], cache: null };
    },
    async readSessionEvents() {
      return [];
    },
    async readWorkspacePresentation(input) {
      return {
        workspace: { workspacePath: input.workspacePath, workspaceKey: workspaceKey(input) },
        mode: "agent",
        slashCommands: [],
      };
    },
    grantWorkspaceHookTrust: () => unsupported("grantWorkspaceHookTrust"),
    async listMcpServerStatuses() {
      return { statuses: {} };
    },
    async getSkillReferenceCatalog() {
      return { authority: "workspace", skills: [] };
    },
    collectLocalRuntimeChildProcesses: () => unsupported("collectLocalRuntimeChildProcesses"),
    generateWorkspaceText: () => unsupported("generateWorkspaceText"),
    async testModelConnectivity(input) {
      const result = await (
        await target.service.commandContext().control()
      ).call({
        type: "test_provider",
        provider: input.selection.providerId,
        modelId: input.selection.modelId,
      });
      if (!result.ok) throw new Error(result.message);
      return { success: true };
    },
    async sendPrompt(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      if (input.modelSelection) {
        await target.service.setModel({
          sessionKey,
          provider: input.modelSelection.providerId,
          modelId: input.modelSelection.modelId,
        });
      }
      const images = await toNekImages(input.attachments);
      await target.service.sendPrompt({
        sessionKey,
        message: input.content,
        ...(images ? { images } : {}),
      });
      return {
        sessionId: input.sessionId,
        accepted: true,
        stateRevision: target.service.conversationSnapshot(sessionKey).revision,
      } satisfies LegacySendResult;
    },
    async compactSession(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      const result = await target.service.compact({ sessionKey, instructions: input.instructions });
      return {
        response: result.summary,
        snapshot: await bindingSnapshot(target, input),
        compact: { state: "accepted" },
      } satisfies LegacyCompactResult;
    },
    goalSession: () => unsupported("goalSession"),
    async closeSession(input) {
      return await target.closeNekSession(input);
    },
    async setModel(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      await target.service.setModel({
        sessionKey,
        provider: input.model.providerId,
        modelId: input.model.modelId,
      });
      return (await bindingSnapshot(target, input)) satisfies LegacyModelResult;
    },
    async setThoughtLevel(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      await target.service.setThinkingLevel({ sessionKey, level: input.thoughtLevel as never });
      return (await bindingSnapshot(target, input)) satisfies LegacyThoughtResult;
    },
    async setMode(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      await target.service.setMode({ sessionKey, mode: input.mode });
      return (await bindingSnapshot(target, input)) satisfies LegacyModeResult;
    },
    respondSessionRuntimePreferences: () => unsupported("respondSessionRuntimePreferences"),
    onDynamicSessionRuntimePreferencesRequest: emptyEvent,
    onDynamicProcessResourceSample: emptyEvent,
    onDynamicMcpTelemetry: emptyEvent,
    onDynamicMcpResourceSamples: emptyEvent,
    onDynamicToolExecResource: emptyEvent,
    onDynamicSessionEvent: emptyEvent,
    async helloConversationV4() {
      return emptyHello();
    },
    async initializeConversationV4(_clientHello: ClientHello) {
      return;
    },
    setConnectionFlowStateV4: () => unsupported("setConnectionFlowStateV4"),
    async conversationRowsRangeV4(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      const snapshot = target.service.conversationSnapshot(sessionKey);
      const beforeRowId = input.beforeRowId;
      const beforeIndex =
        beforeRowId !== undefined
          ? snapshot.rows.window.findIndex((row) => row.rowId === beforeRowId)
          : -1;
      const rows =
        beforeRowId !== undefined
          ? beforeIndex >= 0
            ? snapshot.rows.window.slice(0, beforeIndex)
            : []
          : snapshot.rows.window;
      const window = rows.slice(-input.limit);
      return {
        rows: window,
        atSeq: snapshot.seq,
        atRevision: snapshot.revision,
        atLogEpoch: snapshot.logEpoch,
        hasMore: window.length < rows.length,
      };
    },
    conversationPlansV4: async (input): Promise<V4ConversationPlansResult> => ({
      plans: [],
      atSeq: 0,
      atLogEpoch: `nek:${workspaceKey(input)}`,
    }),
    backgroundBashOutputV4: () => unsupported("backgroundBashOutputV4"),
    conversationFileChangesV4: () =>
      unsupported<V4ConversationFileChangesResult>("conversationFileChangesV4"),
    conversationFileRewindPreviewV4: () =>
      unsupported<V4ConversationFileRewindPreviewResult>("conversationFileRewindPreviewV4"),
    sendConversationCommandV4: async (input) =>
      await target.sendNekConversationCommandV4({
        target: input,
        envelope: input.envelope as NekSessionCommandEnvelope,
      }),
    queryConversationCommandsV4: async (input) =>
      await target.queryNekConversationCommandsV4({
        target: input,
        commands: input.commands,
        clock: input.clock,
      }),
    attachmentBeginV4: () => unsupported<V4AttachmentBeginResult>("attachmentBeginV4"),
    attachmentChunkV4: () => unsupported<V4AttachmentChunkResult>("attachmentChunkV4"),
    attachmentCommitV4: () => unsupported<V4AttachmentCommitResult>("attachmentCommitV4"),
    attachmentAbortV4: () => unsupported("attachmentAbortV4"),
    attachmentPreviewSourceV4: () =>
      unsupported<V4AttachmentPreviewSourceResult>("attachmentPreviewSourceV4"),
    attachmentReadV4: () => unsupported<V4AttachmentReadResult>("attachmentReadV4"),
    conversationAttachmentReadV4: () =>
      unsupported<V4ConversationAttachmentReadResult>("conversationAttachmentReadV4"),
    conversationAttachmentStatV4: () =>
      unsupported<V4ConversationAttachmentStatResult>("conversationAttachmentStatV4"),
    onDynamicDiagnostic: emptyEvent,
    onDynamicSessionActivity: emptyEvent,
    onDynamicLocalTtftFacts: emptyEvent,
    onDynamicConversationTelemetryFact: emptyEvent,
    onAgentRuntimeRestarted: (listener) => {
      const detach = target.service.onEvent((event) => {
        if (event.type === "process_exit")
          listener({ workspaceKey: workspaceKey({ workspacePath: event.session.cwd }) });
      });
      return { dispose: detach };
    },
    async disposeWorkspace(input) {
      const sessions = await target.listNekSessions(input);
      for (const summary of sessions) {
        const sessionKey = target.resolveSessionKey(input, summary.id);
        if (sessionKey) await target.closeNekSession({ ...input, sessionId: summary.id });
      }
    },
    disposeAll() {
      void target.dispose();
    },
  };
  return methods;
}

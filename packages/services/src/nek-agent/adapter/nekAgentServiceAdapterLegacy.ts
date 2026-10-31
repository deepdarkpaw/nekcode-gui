import type {
  ClientHello,
  ToolCallRow,
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
import type { NekPlanSummary } from "@zcode/shared/nek-protocol";
import type { NekSessionCommandEnvelope } from "./types.js";
import { isNekState } from "../service/types.js";
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
import type { ZCodeModelProviderAvailability } from "../../zcode-agent/zcodeAgent.js";
import { createNekAgentRuntimeLifecycle } from "./nekAgentRuntimeLifecycle.js";

function isPlanWithMarkdown(value: unknown): value is NekPlanSummary & { markdown: string } {
  if (typeof value !== "object" || value === null) return false;
  const plan = value as Partial<NekPlanSummary & { markdown: string }>;
  return (
    typeof plan.path === "string" &&
    typeof plan.name === "string" &&
    typeof plan.overview === "string" &&
    typeof plan.revision === "number" &&
    (plan.status === "draft" || plan.status === "ready") &&
    Array.isArray(plan.todos) &&
    typeof plan.markdown === "string"
  );
}

function planRow(
  plan: NekPlanSummary & { markdown: string },
  rowId: number,
  createdAt: number,
): ToolCallRow {
  return {
    rowId,
    turnId: `nek-plan:${plan.path}`,
    entityId: `nek-plan:${plan.path}`,
    kind: "toolCall",
    toolCallId: plan.path,
    toolName: "nek.plan",
    status: "success",
    inputText: JSON.stringify(plan),
    input: plan,
    output: { text: plan.markdown },
    createdAt,
    createdAtSeq: rowId,
  };
}

export function createNekLegacyMethods(
  target: NekAgentServiceAdapterLegacyTarget,
  readModelAvailability: () => Promise<ZCodeModelProviderAvailability>,
): LegacyMethods {
  // 代际记忆只有一个 owner：被动事件与此处的 identity 查询共用同一份，事件自增而查询
  // 恒为 1 会让观察者把新代当成旧代。
  const runtimeLifecycle = createNekAgentRuntimeLifecycle(target.service);
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
      return runtimeLifecycle.getIdentity(input.workspacePath);
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
    async stopSubagent(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      return await target.service.stopSubagent({ sessionKey, id: input.id });
    },
    async getSubagentTranscript(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      return await target.service.getSubagentTranscript({ sessionKey, id: input.id });
    },
    async listAgentTypes(input) {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      return await target.service.listAgentTypes(sessionKey);
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
    async conversationPlansV4(input): Promise<V4ConversationPlansResult> {
      const sessionKey = target.resolveSessionKey(input, input.sessionId);
      if (!sessionKey) throw new Error(`nek session ${input.sessionId} is not open`);
      const commandTarget = target.service.commandContext().target(sessionKey);
      const stateResponse = await commandTarget.client.call({
        type: "extension_call",
        method: "nek.get_state",
      });
      if (!isNekState(stateResponse.result))
        throw new Error("nek returned an invalid state snapshot");
      const limit = target.service.runtimeConfig.nek.maxConversationPlans;
      const summaries = stateResponse.result.plans.slice(-limit).reverse();
      const plans = await Promise.all(
        summaries.map(async (summary, index) => {
          const response = await commandTarget.client.call({
            type: "extension_call",
            method: "nek.get_plan",
            params: { path: summary.path },
          });
          if (!isPlanWithMarkdown(response.result))
            throw new Error(`nek returned an invalid plan: ${summary.path}`);
          return planRow(response.result, index, Date.now());
        }),
      );
      const snapshot = target.service.conversationSnapshot(sessionKey);
      return {
        plans,
        atSeq: snapshot.seq,
        atLogEpoch: snapshot.logEpoch,
      };
    },
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
    onAgentRuntimeLifecycle: (listener) => runtimeLifecycle.onDidChange(listener),
    getModelProviderAvailability: () => readModelAvailability(),
    async disposeWorkspace(input) {
      const sessions = await target.listNekSessions(input);
      for (const summary of sessions) {
        const sessionKey = target.resolveSessionKey(input, summary.id);
        if (sessionKey) await target.closeNekSession({ ...input, sessionId: summary.id });
      }
    },
    disposeAll() {
      runtimeLifecycle.dispose();
      void target.dispose();
    },
  };
  return methods;
}

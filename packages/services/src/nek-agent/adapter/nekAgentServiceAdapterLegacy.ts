import type {
  ClientHello,
  ToolCallRow,
  V4ConversationPlansResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4AttachmentPreviewSourceResult,
} from "@zcode/shared/zcode-protocol-v4";
import { toNekImages } from "./attachmentImages.js";
import type { NekPlanSummary } from "@zcode/shared/nek-protocol";
import type { NekSessionCommandEnvelope } from "./types.js";
import { isNekState } from "../service/types.js";
import {
  bindingSnapshot,
  existingBindingSnapshot,
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
import { readTrustedZCodeAgentV4Connection } from "../../zcode-agent/zcodeAgentConnectionScope.js";
import { workspaceKey } from "./frameHelpers.js";
import { createNekAgentRuntimeLifecycle } from "./nekAgentRuntimeLifecycle.js";
import { isListedNekSession } from "./nekSessionListing.js";
import { createNekUserImageAttachmentMethods } from "./nekUserImageAttachments.js";

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

export function createNekLegacyMethods(target: NekAgentServiceAdapterLegacyTarget): LegacyMethods {
  // 被动事件与 identity 查询共用同一份代际记忆。
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
      return await bindingSnapshot(target, input, true);
    },
    async listSessions(input) {
      const summaries = await target.listNekSessions(input);
      return summaries
        .filter(isListedNekSession)
        .map((summary) => legacySessionInfo(input, summary));
    },
    async listSessionSubagents() {
      return { revision: 0, childSessionIds: [], running: [], ended: { total: 0, items: [] } };
    },
    async stopSubagent(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
      return await target.service.stopSubagent({ sessionKey, id: input.id });
    },
    async getSubagentTranscript(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
      return await target.service.getSubagentTranscript({ sessionKey, id: input.id });
    },
    async listAgentTypes(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
      return await target.service.listAgentTypes(sessionKey);
    },
    async getTaskTokenUsage(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
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
      if (input.runtimePolicy === "existing-only") return existingBindingSnapshot(target, input);
      return await bindingSnapshot(target, input);
    },
    async readSessionMessages(input) {
      await target.ensureNekSessionBinding(input, input.sessionId);
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
    async sendPrompt(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
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
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
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
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
      await target.service.setModel({
        sessionKey,
        provider: input.model.providerId,
        modelId: input.model.modelId,
      });
      return (await bindingSnapshot(target, input)) satisfies LegacyModelResult;
    },
    async setThoughtLevel(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
      await target.service.setThinkingLevel({ sessionKey, level: input.thoughtLevel as never });
      return (await bindingSnapshot(target, input)) satisfies LegacyThoughtResult;
    },
    async setMode(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
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
    // nek 的帧按 workspace 广播，没有按连接限流的投递队列：saturated/drained 无事可做；
    // closed 表示该连接已断开，作废它进行中的附件上传。
    async setConnectionFlowStateV4(input) {
      if (input.state !== "closed") return;
      const connection = readTrustedZCodeAgentV4Connection(input);
      if (connection) await target.attachments.closeConnection(connection.connectionId);
    },
    async conversationRowsRangeV4(input) {
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
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
      const { sessionKey } = await target.ensureNekSessionBinding(input, input.sessionId);
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
    async attachmentBeginV4(input) {
      return await target.attachments.begin(
        input,
        readTrustedZCodeAgentV4Connection(input)?.connectionId,
      );
    },
    async attachmentChunkV4(input) {
      return await target.attachments.chunk(input);
    },
    async attachmentCommitV4(input) {
      return await target.attachments.commit(input);
    },
    async attachmentAbortV4(input) {
      await target.attachments.abort(input);
    },
    attachmentPreviewSourceV4: () =>
      unsupported<V4AttachmentPreviewSourceResult>("attachmentPreviewSourceV4"),
    ...createNekUserImageAttachmentMethods(target),
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
    async disposeWorkspace(input) {
      const sessions = await target.listNekSessions(input);
      for (const summary of sessions) {
        const sessionKey = target.resolveSessionKey(input, summary.id);
        if (sessionKey) await target.closeNekSession({ ...input, sessionId: summary.id });
      }
    },
    disposeAll() {
      void methods.disposeAllAndWait().catch((error: unknown) => {
        target.logger?.warn("failed to dispose the nek agent service", error);
      });
    },
    async disposeAllAndWait() {
      runtimeLifecycle.dispose();
      await target.dispose();
    },
  };
  return methods;
}

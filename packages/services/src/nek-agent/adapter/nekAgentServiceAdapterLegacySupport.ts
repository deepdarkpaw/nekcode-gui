import type { Event } from "@zcode/rpc";
import type { HelloMessage, V4ConversationRowsRangeResult } from "@zcode/shared/zcode-protocol-v4";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import type { NekSessionSummary } from "@zcode/shared/nek-protocol";
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import type { NekAgentService } from "../service/nekAgentService.js";
import type { NekSessionResult } from "../service/types.js";
import type { NekAgentServiceAdapterApi, NekWorkspaceTarget } from "./types.js";
import { workspaceKey } from "./frameHelpers.js";

export interface NekAgentServiceAdapterLegacyTarget extends NekAgentServiceAdapterApi {
  readonly service: NekAgentService;
  resolveSessionKey(target: NekWorkspaceTarget, sessionId?: string): string | undefined;
}

export type LegacySnapshot = Awaited<ReturnType<IZCodeAgentService["readSession"]>>;
export type LegacySessionInfo = Awaited<ReturnType<IZCodeAgentService["listSessions"]>>[number];
export type LegacySendResult = Awaited<ReturnType<IZCodeAgentService["sendPrompt"]>>;
export type LegacyCompactResult = Awaited<ReturnType<IZCodeAgentService["compactSession"]>>;
export type LegacyModelResult = Awaited<ReturnType<IZCodeAgentService["setModel"]>>;
export type LegacyThoughtResult = Awaited<ReturnType<IZCodeAgentService["setThoughtLevel"]>>;
export type LegacyModeResult = Awaited<ReturnType<IZCodeAgentService["setMode"]>>;

export type LegacyMethods = Partial<IZCodeAgentService> & {
  createSession: IZCodeAgentService["createSession"];
  resumeSession: IZCodeAgentService["resumeSession"];
  listSessions: IZCodeAgentService["listSessions"];
  readSession: IZCodeAgentService["readSession"];
  readSessionMessages: IZCodeAgentService["readSessionMessages"];
  sendPrompt: IZCodeAgentService["sendPrompt"];
  compactSession: IZCodeAgentService["compactSession"];
  setModel: IZCodeAgentService["setModel"];
  setThoughtLevel: IZCodeAgentService["setThoughtLevel"];
  setMode: IZCodeAgentService["setMode"];
  closeSession: IZCodeAgentService["closeSession"];
  sendConversationCommandV4: IZCodeAgentService["sendConversationCommandV4"];
  queryConversationCommandsV4: IZCodeAgentService["queryConversationCommandsV4"];
};

export const unsupported = <T>(operation: string): Promise<T> => {
  throw new Error(`nek 模式不支持旧 ZCode 操作：${operation}`);
};

export function emptyEvent<T>(): Event<T> {
  return () => ({ dispose: () => undefined });
}

function phaseToStatus(phase: NekSessionResult["phase"]): LegacySnapshot["session"]["status"] {
  if (phase === "running") return "running";
  if (phase === "waiting_input") return "waiting";
  if (phase === "error") return "error";
  if (phase === "locked") return "paused";
  return "idle";
}

export function legacySnapshotFromResult(
  input: NekWorkspaceTarget,
  result: NekSessionResult,
  mode: "agent" | "plan" = "agent",
): LegacySnapshot {
  const now = Date.now();
  const status = phaseToStatus(result.phase);
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: result.sessionId,
      workspace: {
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        ...(input.remoteSessionId ? { remoteSessionId: input.remoteSessionId } : {}),
        workspaceKey: workspaceKey(input),
      },
      sessionKind: "interactive",
      title: "",
      titleSource: "default",
      mode,
      status,
      createdAt: now,
      updatedAt: now,
    },
    settings: {
      model: { available: [] },
      thoughtLevel: {
        enabled: true,
        current: "medium",
        defaultLevel: "medium",
        available: [{ value: "medium", label: "medium" }],
      },
      mode: { current: mode },
    },
    projection: {
      sessionId: result.sessionId,
      status,
      mode,
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 0,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
      target: null,
    },
    runtime: {
      eventSeq: result.conversation.seq,
      stateRevision: result.conversation.revision,
      pendingRequestIds: [],
    },
    messages: [],
    slashCommands: [],
  };
}

export function legacySessionInfo(
  target: NekWorkspaceTarget,
  summary: NekSessionSummary,
): LegacySessionInfo {
  const updatedAt = Date.parse(summary.modifiedAt);
  const createdAt = Date.parse(summary.createdAt);
  return {
    sessionId: summary.id,
    workspace: { workspacePath: target.workspacePath, workspaceKey: workspaceKey(target) },
    sessionKind: "interactive",
    title: summary.name ?? summary.firstMessage ?? "",
    titleSource: summary.name ? "custom" : "default",
    mode: "agent",
    status: summary.locked ? "paused" : "completed",
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

export async function bindingSnapshot(
  target: NekAgentServiceAdapterLegacyTarget,
  input: Parameters<IZCodeAgentService["readSession"]>[0],
): Promise<LegacySnapshot> {
  const sessionKey = target.resolveSessionKey(input, input.sessionId);
  if (!sessionKey) {
    const summary = (await target.listNekSessions(input)).find(
      (item) => item.id === input.sessionId,
    );
    if (!summary) throw new Error(`nek session ${input.sessionId} is not open`);
    const resumed = await target.resumeNekSession({
      workspacePath: input.workspacePath,
      sessionPath: summary.path,
    });
    return legacySnapshotFromResult(input, resumed);
  }
  const session = target.service.getSession(sessionKey);
  if (!session) throw new Error(`nek session ${input.sessionId} is not open`);
  return legacySnapshotFromResult(input, {
    ...session,
    conversation: target.service.conversationSnapshot(sessionKey),
  });
}

export function emptyRowsResult(
  input: Parameters<IZCodeAgentService["conversationRowsRangeV4"]>[0],
): V4ConversationRowsRangeResult {
  return {
    rows: [],
    atSeq: 0,
    atRevision: 0,
    atLogEpoch: `nek:${workspaceKey(input)}`,
    hasMore: false,
  };
}

export function emptyHello(): HelloMessage {
  return {
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "nek-local",
    clientMode: "desktop-continuous",
    deliveryProfile: "continuous",
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: true,
      localTerminal: true,
      binaryFrames: false,
      compression: "none",
      workspaceHookReview: false,
      independentPlanState: true,
    },
    auth: {},
  };
}

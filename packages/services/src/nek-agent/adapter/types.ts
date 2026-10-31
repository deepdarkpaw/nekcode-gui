import type { Event } from "@zcode/rpc";
import type {
  CommandsQueryResult,
  ConversationTopicWireCandidate,
  ConversationSnapshot,
  SessionsIndexTopicWireCandidate,
  V4ConversationResyncResult,
  V4ConversationSubscribeResult,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { NekAgentServiceOptions } from "../service/types.js";
import type { ZCodeModelProviderAvailability } from "../../zcode-agent/zcodeAgent.js";

export interface NekAgentServiceAdapterOptions extends NekAgentServiceOptions {
  /** GUI 元数据索引；未注入时使用有界内存索引。 */
  sessionIndexSyncer?: import("../index/nekSessionIndexSyncer.js").NekSessionIndexSyncer;
  maxV4Subscriptions?: number;
  /** nek 侧模型事实读取；默认按已定位的 agentDir 读 models.json / settings.json。 */
  readModelAvailability?: () => Promise<ZCodeModelProviderAvailability>;
}

export interface NekWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

export interface NekConversationSubscribeParams extends NekWorkspaceTarget {
  sessionId: string;
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
}

export interface NekConversationUnsubscribeParams extends NekWorkspaceTarget {
  subscriptionId: string;
}

export interface NekConversationResyncParams extends NekWorkspaceTarget {
  subscriptionId: string;
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

export interface NekSessionsIndexSubscribeParams extends NekWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
}

export interface NekWorkspaceConfigSubscribeParams extends NekWorkspaceTarget {
  base?: { logEpoch: string; seq: number };
  visibility?: "foreground" | "background";
  subscriberScope?: string;
}

export interface NekSessionBinding {
  target: NekWorkspaceTarget;
  sessionKey: string;
  sessionId: string;
  sessionPath?: string;
}

export interface NekSessionCommandEnvelope {
  commandId: string;
  clientId: string;
  sessionId: string | null;
  type: string;
  payload: unknown;
  issuedAt: number;
  baseRevision?: number;
  baseLogEpoch?: string;
}

export interface NekAgentServiceAdapterApi {
  initialize(target: NekWorkspaceTarget): Promise<{ available: boolean; workspaceKey: string }>;
  createNekSession(input: {
    workspacePath: string;
    sessionId?: string;
    model?: { provider: string; modelId: string };
    thinking?: import("@zcode/shared/nek-protocol").NekThinkingLevel;
    mode?: import("@zcode/shared/nek-protocol").NekMode;
  }): Promise<import("../service/types.js").NekSessionResult>;
  resumeNekSession(input: {
    workspacePath: string;
    sessionPath: string;
  }): Promise<import("../service/types.js").NekSessionResult>;
  listNekSessions(
    target: NekWorkspaceTarget,
  ): Promise<import("@zcode/shared/nek-protocol").NekSessionSummary[]>;
  closeNekSession(input: NekWorkspaceTarget & { sessionId: string }): Promise<boolean>;
  readNekSession(input: NekWorkspaceTarget & { sessionId: string }): Promise<ConversationSnapshot>;
  readNekSessionMessages(
    target: NekWorkspaceTarget & { sessionId: string },
  ): Promise<import("@zcode/shared/nek-protocol").NekAgentMessage[]>;
  subscribeConversationV4(
    input: NekConversationSubscribeParams,
  ): Promise<V4ConversationSubscribeResult>;
  resyncConversationV4(input: NekConversationResyncParams): Promise<V4ConversationResyncResult>;
  unsubscribeConversationV4(input: NekConversationUnsubscribeParams): Promise<void>;
  onDynamicConversationFrame(target: NekWorkspaceTarget): Event<ConversationTopicWireCandidate>;
  subscribeSessionsIndexV4(
    input: NekSessionsIndexSubscribeParams,
  ): Promise<V4SessionsIndexSubscribeResult>;
  resyncSessionsIndexV4(input: NekConversationResyncParams): Promise<V4ConversationResyncResult>;
  unsubscribeSessionsIndexV4(input: NekConversationUnsubscribeParams): Promise<void>;
  onDynamicSessionsIndexFrame(target: NekWorkspaceTarget): Event<SessionsIndexTopicWireCandidate>;
  subscribeWorkspaceConfigV4(
    input: NekWorkspaceConfigSubscribeParams,
  ): Promise<V4WorkspaceConfigSubscribeResult>;
  resyncWorkspaceConfigV4(input: NekConversationResyncParams): Promise<V4ConversationResyncResult>;
  unsubscribeWorkspaceConfigV4(input: NekConversationUnsubscribeParams): Promise<void>;
  onDynamicWorkspaceConfigFrame(
    target: NekWorkspaceTarget,
  ): Event<WorkspaceConfigTopicWireCandidate>;
  sendNekConversationCommandV4(input: {
    target: NekWorkspaceTarget;
    envelope: NekSessionCommandEnvelope;
  }): Promise<import("@zcode/shared/zcode-protocol-v4").CommandAck>;
  queryNekConversationCommandsV4(input: {
    target: NekWorkspaceTarget;
    commands: Array<{ sessionId: string | null; commandId: string }>;
    clock?: true;
  }): Promise<CommandsQueryResult>;
  dispose(): Promise<void>;
}

export type NekV4Frame =
  | ConversationTopicWireCandidate
  | SessionsIndexTopicWireCandidate
  | WorkspaceConfigTopicWireCandidate;

export interface NekSubscriptionHandle {
  readonly subscriptionId: string;
  readonly topic: string;
  readonly workspaceKey: string;
  readonly dispose: () => void;
  readonly onFrame: (frame: NekV4Frame, deliveryKind: "initial" | "online" | "recovery") => void;
}

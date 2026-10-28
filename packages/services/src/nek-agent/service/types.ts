import type { GuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import type { ConversationSnapshot, ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type {
  NekAgentMessage,
  NekGuiInfo,
  NekProjectTrust,
  NekRpcEvent,
  NekRpcSessionState,
  NekSessionEntry,
  NekSessionSnapshot,
  NekSessionStats,
  NekSessionSummary,
  NekState,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import type { NekRpcProcess } from "../nekRpcProcess.js";
import type { NekRpcProcessExit } from "../nekRpcClient.js";
import type { NekProcessPool } from "../nekProcessPool.js";
import type { NekConversationProjector } from "../nekConversationProjector.js";

export type NekSessionPhase = "idle" | "running" | "waiting_input" | "error" | "locked";

export interface NekSessionRecord {
  key: string;
  sessionId: string;
  path?: string;
  cwd: string;
  process?: NekRpcProcess;
  detachEvents?: () => void;
  detachExit?: () => void;
  projector?: NekConversationProjector;
  state?: NekRpcSessionState;
  snapshot?: NekSessionSnapshot;
  phase: NekSessionPhase;
  readonly: boolean;
  /** 只读快照的占用者；nek 只报 `locked: true`，因此恒为 `"nek"`。 */
  lockedBy?: string;
  closing: boolean;
}

export interface NekSession {
  sessionKey: string;
  sessionId: string;
  sessionPath?: string;
  cwd: string;
  phase: NekSessionPhase;
  readonly: boolean;
  lockedBy?: string;
  processId?: number;
  /** Only present for a read-only snapshot. */
  snapshot?: NekSessionSnapshot;
}

export interface NekSessionResult extends NekSession {
  conversation: ConversationSnapshot;
}

export interface NekPromptInput {
  sessionKey: string;
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  streamingBehavior?: "steer" | "follow_up" | "followUp";
}

export interface NekSessionProcessCreateOptions {
  sessionKey: string;
  cwd: string;
  sessionPath?: string;
  approve?: boolean;
  extensionUi?: NekExtensionUiHandler;
}

export interface NekTrustPromptContext {
  trust: NekProjectTrust;
  cwd: string;
  signal?: AbortSignal;
}

export type NekTrustPrompt = (context: NekTrustPromptContext) => Promise<boolean> | boolean;

export interface NekAgentServiceOptions {
  runtimeConfig?: GuiRuntimeConfig;
  guiInfo?: NekGuiInfo;
  cwd?: string;
  processPool?: NekProcessPool<NekRpcProcess>;
  createSessionProcess?: (
    options: NekSessionProcessCreateOptions,
  ) => Promise<NekRpcProcess> | NekRpcProcess;
  createControlProcess?: () => Promise<NekRpcProcess> | NekRpcProcess;
  askProjectTrust?: NekTrustPrompt;
  extensionUi?: NekExtensionUiHandler;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

export type NekAgentServiceEvent =
  | {
      type: "state";
      session: NekSession;
      previous: NekSessionPhase;
      state: NekSessionPhase;
    }
  | {
      type: "rpc_event";
      session: NekSession;
      event: NekRpcEvent;
    }
  | { type: "process_exit"; session: NekSession; exit: NekRpcProcessExit }
  | { type: "resume_notice"; session: NekSession; message: "正在继续上次中断的回合" };

export interface NekConversationListener {
  (frame: ConversationTopicFrame): void;
}

export interface NekLoadedSessionData {
  entries: NekSessionEntry[];
  messages?: NekAgentMessage[];
  state?: NekRpcSessionState;
  stats?: NekSessionStats;
  nekState?: NekState;
}

export interface NekSessionListOptions {
  cwd?: string;
  all?: boolean;
  limit?: number;
}

export interface NekSessionMetadata {
  summary: NekSessionSummary;
  state?: NekRpcSessionState;
  stats?: NekSessionStats;
}

export type NekModelSelection = { provider: string; modelId: string };
export type NekMode = "agent" | "plan";
/** 思考等级按 nek 的取值收窄，避免把非法等级写上线。 */
export type NekThoughtLevel = NekThinkingLevel;

export function isNekState(value: unknown): value is NekState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<NekState>;
  return (
    (state.mode === "agent" || state.mode === "plan") &&
    Array.isArray(state.todos) &&
    Array.isArray(state.plans) &&
    Array.isArray(state.subagents)
  );
}

export function isNekSessionSnapshot(value: unknown): value is NekSessionSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<NekSessionSnapshot>;
  return (
    typeof snapshot.session === "object" &&
    snapshot.session !== null &&
    Array.isArray(snapshot.entries) &&
    Array.isArray(snapshot.messages) &&
    (typeof snapshot.leafId === "string" || snapshot.leafId === null)
  );
}

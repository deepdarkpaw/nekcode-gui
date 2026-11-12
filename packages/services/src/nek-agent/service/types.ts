import type { GuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import type {
  ConversationOpenTiming,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  NekAgentMessage,
  NekGuiInfo,
  NekProjectTrust,
  NekPromptAttachment,
  NekRpcEvent,
  NekRpcSessionState,
  NekSessionEntry,
  NekSessionLockHolder,
  NekSessionSnapshot,
  NekSessionStats,
  NekSessionSummary,
  NekState,
  NekThinkingLevel,
  NekModelRuntimeFreshness,
  NekModelRuntimeLease,
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
  modelRuntime?: NekModelRuntimeLease;
  projector?: NekConversationProjector;
  state?: NekRpcSessionState;
  snapshot?: NekSessionSnapshot;
  phase: NekSessionPhase;
  /**
   * GUI 侧压缩预约：`compact` 请求发出到 CLI 的 `compaction_start` 之间按压缩处理。
   *
   * 预约只影响输入接纳（压缩中不把消息发给 CLI），在首个 await 之前就置位，
   * 避免同一 tick 的下一条输入抢跑到 CLI；`compaction_start` 到达后由
   * `state.isCompacting` 接管。
   */
  compactReserved?: boolean;
  /**
   * 生命周期世代：agent 回合、压缩、手动压缩预约每次推进。
   *
   * 异步快照只在世代未变时才能覆盖 `state` 并收口待发输入，避免早于事件的
   * `get_state` 结果把 `isCompacting` 覆盖回 false。
   */
  stateEpoch?: number;
  readonly: boolean;
  /** 只读快照的占用者，人类可读；nek 不报持有者时为 `"nek"`。 */
  lockedBy?: string;
  /** nek 报出的锁持有者详情；早于 P2c 的 nek 只报 `locked: true`，此处缺省。 */
  lockHolder?: NekSessionLockHolder;
  closing: boolean;
  /** 本次运行经 `createSession` 新建；退出时若仍没有消息就删除（见 `nekUnusedSessionCleanup.ts`）。 */
  createdThisRun?: boolean;
}

export interface NekSession {
  sessionKey: string;
  sessionId: string;
  sessionPath?: string;
  cwd: string;
  phase: NekSessionPhase;
  readonly: boolean;
  /** 压缩进行中（含 GUI 预约）：输入由 GUI 暂存，压缩收口后再提交。 */
  isCompacting?: boolean;
  lockedBy?: string;
  lockHolder?: NekSessionLockHolder;
  processId?: number;
  /** Only present for a read-only snapshot. */
  snapshot?: NekSessionSnapshot;
}

export interface NekSessionResult extends NekSession {
  conversation: ConversationSnapshot;
  /** 仅随本次恢复返回的技术时长；不写入会话记录或 conversation 快照。 */
  openTiming?: ConversationOpenTiming;
}

export interface NekPromptInput {
  sessionKey: string;
  message: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  attachments?: NekPromptAttachment[];
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
  modelRuntime?: NekModelRuntimeFreshness;
  createSessionProcess?: (
    options: NekSessionProcessCreateOptions,
  ) => Promise<NekRpcProcess> | NekRpcProcess;
  createControlProcess?: () => Promise<NekRpcProcess> | NekRpcProcess;
  askProjectTrust?: NekTrustPrompt;
  extensionUi?: NekExtensionUiHandler;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

export type NekAgentServiceEvent =
  | { type: "catalog_changed"; topic: "index" | "config"; cwd?: string }
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
  /**
   * 会话记录刚挂上一个可用的 nek 进程：新会话、恢复会话，或池回收后按会话文件重连。
   *
   * 这是 workspace runtime 恢复的唯一事实来源。phase 事件不能代替它：新建会话的
   * phase 从 `idle` 开始、重连后仍是 `idle`，`setPhase` 遇到相同值不会发 `state`，
   * 用 phase 推断恢复会让观察者永久休眠。
   */
  | { type: "process_attached"; session: NekSession }
  | { type: "process_exit"; session: NekSession; exit: NekRpcProcessExit };

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
    (typeof snapshot.leafId === "string" || snapshot.leafId === null) &&
    (snapshot.lockedBy === undefined || isNekSessionLockHolder(snapshot.lockedBy))
  );
}

/** 锁持有者的形状校验：协议漂移要报错，不能让半个持有者混进会话记录。 */
function isNekSessionLockHolder(value: unknown): value is NekSessionLockHolder {
  if (typeof value !== "object" || value === null) return false;
  const holder = value as NekSessionLockHolder;
  return (
    typeof holder.pid === "number" &&
    typeof holder.hostname === "string" &&
    (holder.kind === "tui" ||
      holder.kind === "rpc" ||
      holder.kind === "print" ||
      holder.kind === "json") &&
    typeof holder.startedAt === "string"
  );
}

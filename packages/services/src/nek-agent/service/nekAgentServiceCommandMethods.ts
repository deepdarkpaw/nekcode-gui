import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type {
  NekBashResult,
  NekCompactionResult,
  NekCycleModelResult,
  NekMentionTargetInfo,
  NekModel,
  NekAgentTypeInfo,
  NekReloadResult,
  NekSubagentRecord,
  NekRpcSlashCommand,
  NekSessionEntry,
  NekSessionStats,
  NekStatusQueue,
  NekSessionTreeNode,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import type { NekConversationListener, NekMode, NekPromptInput, NekThoughtLevel } from "./types.js";

/** 排队输入的快照：nek 的 `clear_queue` 边返回边清空，没有只读 peek。 */
export type NekQueueSnapshot = NekStatusQueue;

/**
 * `NekAgentService` 的命令面：每条命令对应一次 nek 会话进程 RPC。
 *
 * 语义与 nek 一致（见 `docs/rpc-commands.md`）：只读会话（`readonly`）拒绝所有写命令，
 * 命令失败由 `NekRpcClient` 抛错，不做兜底。
 */
export interface NekAgentServiceCommandMethods {
  /** 空闲时发 `prompt`；运行中按 `streamingBehavior` 发 `steer` 或 `follow_up`。 */
  sendPrompt(input: NekPromptInput): Promise<{ disposition: string }>;
  abort(sessionKey: string): Promise<void>;
  bash(input: {
    sessionKey: string;
    command: string;
    excludeFromContext?: boolean;
  }): Promise<NekBashResult>;
  abortBash(sessionKey: string): Promise<void>;
  /** `clear_queue`：取回并清空排队输入。 */
  clearQueue(sessionKey: string): Promise<NekQueueSnapshot>;
  /** `clear_queue` 的别名，语义与 `clearQueue` 相同。 */
  retrieveQueue(sessionKey: string): Promise<NekQueueSnapshot>;
  compact(input: { sessionKey: string; instructions?: string }): Promise<NekCompactionResult>;
  setModel(input: { sessionKey: string; provider: string; modelId: string }): Promise<NekModel>;
  cycleModel(sessionKey: string): Promise<NekCycleModelResult | null>;
  setThinkingLevel(input: { sessionKey: string; level: NekThoughtLevel }): Promise<void>;
  setThoughtLevel(input: { sessionKey: string; level: NekThoughtLevel }): Promise<void>;
  cycleThinkingLevel(sessionKey: string): Promise<{ level: NekThinkingLevel } | null>;
  cycleThoughtLevel(sessionKey: string): Promise<{ level: NekThinkingLevel } | null>;
  getStats(sessionKey: string): Promise<NekSessionStats>;
  reload(sessionKey: string): Promise<NekReloadResult>;
  /** `extension_call nek.set_mode`：nek 没有独立的模式命令。 */
  setMode(input: { sessionKey: string; mode: NekMode }): Promise<unknown>;
  getCommands(sessionKey: string): Promise<NekRpcSlashCommand[]>;
  /** `get_entries`：会话条目（fork / navigateTree / setEntryLabel 需要 entryId）。 */
  getEntries(input: {
    sessionKey: string;
    since?: string;
    limit?: number;
    beforeEntryId?: string;
  }): Promise<{ entries: NekSessionEntry[]; leafId: string | null; hasMore: boolean }>;
  /** `get_tree`：分支树，navigateTree 的候选条目。 */
  getTree(sessionKey: string): Promise<{ tree: NekSessionTreeNode[]; leafId: string | null }>;
  /** `get_fork_messages`：fork 时可回退到的用户消息。 */
  getForkMessages(sessionKey: string): Promise<Array<{ entryId: string; text: string }>>;
  getMentionTargets(
    input: { sessionKey?: string; cwd?: string } | string,
  ): Promise<NekMentionTargetInfo[]>;
  stopSubagent(input: {
    sessionKey: string;
    id: string;
  }): Promise<{ status: NekSubagentRecord["status"] }>;
  getSubagentTranscript(input: {
    sessionKey: string;
    id: string;
  }): Promise<{ messages: unknown[] }>;
  listAgentTypes(sessionKey: string): Promise<{ types: NekAgentTypeInfo[] }>;
  navigateTree(input: {
    sessionKey: string;
    entryId: string;
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  }): Promise<{ cancelled: boolean; editorText?: string }>;
  setEntryLabel(input: { sessionKey: string; entryId: string; label?: string }): Promise<void>;
  fork(input: {
    sessionKey: string;
    entryId: string;
  }): Promise<{ text: string; cancelled: boolean }>;
  clone(sessionKey: string): Promise<{ cancelled: boolean }>;
  exportSession(input: {
    sessionKey: string;
    format: "html" | "jsonl";
    outputPath?: string;
  }): Promise<{ path: string }>;
  shareSession(sessionKey: string): Promise<{ url: string }>;
  importSession(input: { inputPath: string; cwd: string }): Promise<{ sessionPath: string }>;
  /** v4 订阅：立即回放一次快照，然后推增量。 */
  subscribeConversation(sessionKey: string, listener: NekConversationListener): Promise<() => void>;
  conversationSnapshot(sessionKey: string): ConversationSnapshot;
}

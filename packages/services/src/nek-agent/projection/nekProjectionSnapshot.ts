import type {
  ActionAvailability,
  ConversationSnapshot,
  ConversationRow,
  PlanItem,
  QueueItem,
  SessionActionAvailability,
  SessionConfigState,
  SessionControl,
  SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  NekAssistantMessage,
  NekPlanSummary,
  NekRpcSessionState,
  NekSessionEntry,
  NekState,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import type { NekRowIdentity } from "./nekRows.js";
import { buildSubagentRow } from "./nekRows.js";

/**
 * 快照状态构造：把 nek 的状态/统计填成 v4 `ConversationSnapshot` 的各个键。
 *
 * entries → 行的投影在 `nekEntryProjection.ts`；本文件只负责"状态区"
 * （control / config / usage / plan / queue / availability）与行之外的公共构造。
 */

export function summarizeUsage(
  entries: readonly NekSessionEntry[],
  options: { contextWindow?: number; usedTokens?: number } = {},
): SessionUsageState {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let contextTokens = 0;
  for (const entry of entries) {
    if (entry.type === "usage") {
      inputTokens += entry.usage.input;
      outputTokens += entry.usage.output;
      cacheReadTokens += entry.usage.cacheRead;
      cacheWriteTokens += entry.usage.cacheWrite;
      continue;
    }
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = (entry.message as NekAssistantMessage).usage;
    if (!usage) continue;
    inputTokens += usage.input;
    outputTokens += usage.output;
    cacheReadTokens += usage.cacheRead;
    cacheWriteTokens += usage.cacheWrite;
    // 最近一次 assistant 的 input+cacheRead+cacheWrite 是最接近"当前上下文占用"的估计。
    contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  }
  // 上下文档位只能来自 nek 报告的模型窗口（`get_state.model.contextWindow` 或
  // `get_session_stats.contextUsage`）：entries 里没有窗口大小，不要瞎猜。
  const maxTokens = options.contextWindow ?? 0;
  return {
    contextWindow:
      maxTokens > 0
        ? {
            usedTokens: options.usedTokens ?? contextTokens,
            maxTokens,
            autoCompactThresholdTokens: null,
          }
        : null,
    cumulative: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
  };
}

/** `extension_call nek.get_state` 的 todos → v4 plan 状态。cancelled 的 todo 不进 plan。 */
export function planFromNekState(
  state: NekState | undefined,
): { items: PlanItem[]; updatedAt: number } | null {
  if (!state || state.todos.length === 0) return null;
  const items: PlanItem[] = [];
  for (const todo of state.todos) {
    if (todo.status === "cancelled") continue;
    items.push({
      id: todo.id,
      content: todo.content,
      status:
        todo.status === "in_progress"
          ? "inProgress"
          : todo.status === "completed"
            ? "completed"
            : "pending",
    });
  }
  return items.length === 0 ? null : { items, updatedAt: Date.now() };
}

const DEFAULT_THINKING_LEVELS: NekThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function identity(
  entityId: string,
  rowId: number,
  turnId: string,
  createdAt: number,
): NekRowIdentity {
  return { entityId, rowId, turnId, createdAt };
}

/** Canonical session seed comes from nek's accepted facts, never from renderer draft storage. */
export function withNekModelSelection(config: SessionConfigState): SessionConfigState {
  const { provider, model, thought } = config;
  return {
    ...config,
    modelSelection:
      provider && model
        ? {
            providerId: provider,
            modelId: model,
            ...(thought ? { options: { reasoningLevel: thought } } : {}),
          }
        : undefined,
  };
}

export function buildConfigState(
  state: NekRpcSessionState | undefined,
  provider: string,
  model: string,
  thought: string,
  mode: string,
): SessionConfigState {
  return withNekModelSelection({
    provider,
    model,
    thought,
    thoughtLevels: state?.model?.reasoning === false ? ["off"] : [...DEFAULT_THINKING_LEVELS],
    // nek 的 followUpMode（all / one-at-a-time）是"排队项如何消费"，不是 v4 的 queue/guide 语义：
    // 回合中的输入在 nek 里一律排队（steering 才是 guide），所以这里固定 queue。
    followupMode: "queue",
    mode,
  });
}

/** 会话控制态：nek 没有 v4 那么细的状态机，这里给出最小但真实的映射。 */
export function buildControlState(
  state: NekRpcSessionState | undefined,
  phase: SessionControl["phase"],
): SessionControl {
  const running = state?.isStreaming === true || state?.isCompacting === true;
  return {
    phase,
    sessionEnded:
      phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error",
    canStop: running,
    stopState: running ? "stoppable" : "idle",
    stopTargetKind: state?.isCompacting === true ? "compact" : running ? "assistant" : "unknown",
    activeWorks: running
      ? [{ kind: state?.isCompacting === true ? "compact" : "primaryTurn", startedAt: Date.now() }]
      : [],
    lastError: null,
    apiRetry: null,
  };
}

const ALLOWED: ActionAvailability = { allowed: true };

export function buildAvailability(): SessionActionAvailability {
  return {
    fork: ALLOWED,
    compact: ALLOWED,
    switchModelConfig: ALLOWED,
    setFollowupMode: ALLOWED,
    queueEdit: ALLOWED,
    sendQueuedNow: ALLOWED,
    pauseGoal: ALLOWED,
    resumeGoal: ALLOWED,
  };
}

/** `queue_update` 的字符串队列 → v4 queue item（id 由位置合成，nek 没有队列项 id）。 */
export function buildQueueItems(
  steering: readonly string[],
  followUp: readonly string[],
  admittedAt: number,
): QueueItem[] {
  const items: QueueItem[] = [];
  const append = (text: string, kind: "steering" | "followUp", index: number) => {
    const id = `nek-${kind}:${index}`;
    items.push({
      sourceCommandId: id,
      queueItemId: id,
      clientId: "nek",
      kind: "sendText",
      text,
      attachments: [],
      delivery: {
        requested: kind === "steering" ? "guide" : "queue",
        admitted: kind === "steering" ? "guide" : "queue",
      },
      order: { admissionSeq: index },
      steer: { state: kind === "steering" ? "steering" : "notRequested" },
      dispatch: { state: "queued" },
      admittedAt,
    });
  };
  steering.forEach((text, index) => append(text, "steering", index));
  followUp.forEach((text, index) => append(text, "followUp", steering.length + index));
  return items;
}

/** 组装完整快照。所有字段都必须有值，否则 `conversationProjectionStore` 的 zod 校验会拒帧。 */
export function buildConversationSnapshot(args: {
  sessionId: string;
  logEpoch: string;
  seq: number;
  revision: number;
  rows: ConversationRow[];
  totalCount: number;
  firstRowId: number | null;
  title: string;
  config: SessionConfigState;
  usage: SessionUsageState;
  plan: { items: PlanItem[]; updatedAt: number } | null;
  control: SessionControl;
  queue: { items: QueueItem[]; autoDrain: boolean };
}): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: args.sessionId,
    logEpoch: args.logEpoch,
    seq: args.seq,
    revision: args.revision,
    control: args.control,
    availability: args.control.readOnly
      ? (Object.fromEntries(
          Object.keys(buildAvailability()).map((key) => [
            key,
            { allowed: false, reasonCode: "guard.sessionLocked" },
          ]),
        ) as SessionActionAvailability)
      : buildAvailability(),
    inputRouting: args.control.readOnly
      ? { mode: "reject", reasonCode: "guard.sessionLocked" }
      : { mode: "startNow" },
    meta: { title: args.title, titleSource: args.title === "" ? "default" : "custom" },
    config: args.config,
    modelTransition: null,
    usage: args.usage,
    queue: args.queue,
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: args.plan,
    workspaceHookAdmission: null,
    rows: { window: args.rows, totalCount: args.totalCount, firstRowId: args.firstRowId },
  };
}

/** 子代理工具 → subagent 行。`parentToolCallId` 由调用方给出（`subagent` 工具调用 id）。 */
export function subagentRowFromRecord(
  entityId: string,
  rowId: number,
  turnId: string,
  record: {
    id: string;
    description: string;
    type: string;
    status: "running" | "completed" | "errored" | "aborted";
    startedAt: number;
    endedAt?: number;
    finalText?: string;
    error?: string;
    sessionFile?: string;
  },
  parentToolCallId?: string,
): ConversationRow {
  const status =
    record.status === "completed"
      ? "success"
      : record.status === "errored"
        ? "failed"
        : record.status === "aborted"
          ? "cancelled"
          : "running";
  const text = record.finalText ?? record.error ?? record.description;
  return buildSubagentRow(identity(entityId, rowId, turnId, record.startedAt), {
    subagentType: record.type,
    status,
    summaryText: text,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(record.sessionFile ? { childSessionId: record.id } : {}),
    startedAt: record.startedAt,
    ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
  });
}

/** `nek.get_state` 返回的计划摘要 → artifact 行（Plan 列表下钻用，不参与对话主体）。 */
export function planSummaryEntityId(plan: NekPlanSummary): string {
  return `plan:${plan.path}#r${plan.revision}`;
}

import { randomUUID } from "node:crypto";
import type {
  NekAgentTypeInfo,
  NekBashResult,
  NekCompactionResult,
  NekCycleModelResult,
  NekImageContent,
  NekGuiInfo,
  NekMentionTargetInfo,
  NekModel,
  NekModelRuntimeLease,
  NekReloadResult,
  NekRpcSlashCommand,
  NekSessionEntry,
  NekSessionStats,
  NekSessionTreeNode,
  NekStatusSnapshot,
  NekSubagentRecord,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import type { NekRpcClient } from "../nekRpcClient.js";
import type { NekConversationProjector } from "../nekConversationProjector.js";
import { collectPersistedSubagentRecords } from "../projection/nekSubagentRecords.js";
import { isNekState, type NekMode, type NekPromptInput, type NekThoughtLevel } from "./types.js";
export { clearQueue, retrieveQueue, requeueQueue } from "./nekQueueCommands.js";

export interface NekAgentCommandTarget {
  client: NekRpcClient;
  modelRuntime?: NekModelRuntimeLease;
  capabilities?: NekGuiInfo["capabilities"];
  projector?: NekConversationProjector;
  phase: "idle" | "running" | "waiting_input" | "error" | "locked";
  isCompacting?: boolean;
  setPhase: (phase: "idle" | "running" | "waiting_input" | "error" | "locked") => void;
}

/** 在会话租约内执行的一次命令实现（`NekAgentService.runSessionCommand` 的形状）。 */
export type NekAgentCommandRunner<T> = (context: NekAgentCommandContext) => Promise<T>;

export interface NekAgentCommandContext {
  writableTarget: (sessionKey: string) => NekAgentCommandTarget;
  target: (sessionKey: string) => NekAgentCommandTarget;
  control: () => Promise<NekRpcClient>;
}

/**
 * 空闲发 `prompt`；运行中按 `streamingBehavior` 发 `steer` 或 `follow_up`。
 *
 * 压缩是另一条准入路径：压缩期间 `NekAgentService` 根本不调用这里（GUI 先暂存输入），
 * 因此这里不存在"压缩中硬发 follow_up"的分支。
 */
export async function sendPrompt(
  context: NekAgentCommandContext,
  input: NekPromptInput,
): Promise<{ disposition: string }> {
  const target = context.writableTarget(input.sessionKey);
  const submit = () => submitPrompt(context.writableTarget(input.sessionKey), input);
  return await (target.modelRuntime ? target.modelRuntime.run("input", submit) : submit());
}

async function submitPrompt(
  target: NekAgentCommandTarget,
  input: NekPromptInput,
): Promise<{ disposition: string }> {
  const images = input.images as NekImageContent[] | undefined;
  const attachments = input.attachments?.length ? input.attachments : undefined;
  if (attachments && target.capabilities?.promptAttachments !== 1) {
    throw new Error("当前 nek 不支持文件附件，请更新 nek；Remote SSH 会话需要更新远端 nek");
  }
  const content = {
    message: input.message,
    ...(images ? { images } : {}),
    ...(attachments ? { attachments } : {}),
  };
  if (target.phase === "running" || target.phase === "waiting_input") {
    if (!input.streamingBehavior)
      throw new Error("streamingBehavior is required while nek is running");
    if (input.streamingBehavior === "steer")
      return await target.client.call({
        type: "steer",
        ...content,
      });
    return await target.client.call({
      type: "follow_up",
      ...content,
    });
  }
  const result = await target.client.call({
    type: "prompt",
    ...content,
    // nek makes admission atomic: maintenance/a run can begin after our last observed event.
    streamingBehavior: input.streamingBehavior === "steer" ? "steer" : "followUp",
  });
  if (result.disposition === "started") target.setPhase("running");
  return result;
}

export async function abort(context: NekAgentCommandContext, sessionKey: string): Promise<void> {
  const target = context.writableTarget(sessionKey);
  await target.client.call({ type: "abort" });
  target.setPhase("idle");
}

export async function bash(
  context: NekAgentCommandContext,
  input: { sessionKey: string; command: string; excludeFromContext?: boolean },
): Promise<NekBashResult> {
  const target = context.writableTarget(input.sessionKey);
  const id = `bash-${randomUUID()}`;
  const result = await target.client.call({
    id,
    type: "bash",
    command: input.command,
    excludeFromContext: input.excludeFromContext,
  });
  target.projector?.applyBashCommandResult(id, input.command, result);
  target.projector?.flushNow();
  return result;
}

export async function abortBash(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<void> {
  await context.writableTarget(sessionKey).client.call({ type: "abort_bash" });
}

/** 取消自动重试；nek 用 `abort_retry` 单独收口，不会中止当前回合。 */
export async function abortRetry(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<void> {
  await context.writableTarget(sessionKey).client.call({ type: "abort_retry" });
}

/**
 * 状态 feed 的权威快照：`nek.get_state`（运行态）、`get_session_stats`（用量）、
 * `extension_call nek.get_state`（todos/计划/子代理）与 `get_entries`（持久化子代理）一次取齐。
 *
 * 四份事实里任何一份失败都会让整次快照失败：状态卡宁可继续显示上一份，也不拼半个快照。
 */
export async function getStatusSnapshot(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekStatusSnapshot> {
  const target = context.target(sessionKey);
  const [state, stats, entries] = await Promise.all([
    target.client.call({ type: "get_state" }),
    target.client.call({ type: "get_session_stats" }),
    // nek 的 subagent registry 是纯内存表：重开 GUI 后只剩 entries 里 toolResult 的 details。
    target.client.call({ type: "get_entries" }),
  ]);
  // Read the registry after entries: a child registered before its persisted spawn result
  // must be visible here. Parent isStreaming alone never proves a historical child is alive.
  const extension = await target.client.call({ type: "extension_call", method: "nek.get_state" });
  if (!isNekState(extension.result)) {
    throw new Error("nek returned an invalid status state snapshot");
  }
  const live = extension.result;
  // 内存里的子代理是活的权威：histories 只补它没有的 id，绝不覆盖实时状态。
  const persisted = collectPersistedSubagentRecords(entries.entries);
  const liveIds = new Set(live.subagents.map((record) => record.id));
  const restored = [...persisted.values()]
    .filter((entry) => !liveIds.has(entry.record.id))
    .map((entry) => entry.record);
  return {
    sessionKey: state.sessionId,
    running: state.isStreaming,
    compacting: state.isCompacting,
    pendingMessageCount: state.pendingMessageCount,
    state: restored.length === 0 ? live : { ...live, subagents: [...live.subagents, ...restored] },
    stats,
  };
}

export async function compact(
  context: NekAgentCommandContext,
  input: { sessionKey: string; instructions?: string },
): Promise<NekCompactionResult> {
  return await context.writableTarget(input.sessionKey).client.call({
    type: "compact",
    customInstructions: input.instructions,
  });
}

export async function setModel(
  context: NekAgentCommandContext,
  input: { sessionKey: string; provider: string; modelId: string },
): Promise<NekModel> {
  const target = context.writableTarget(input.sessionKey);
  const select = () =>
    target.client.call({ type: "set_model", provider: input.provider, modelId: input.modelId });
  return await (target.modelRuntime ? target.modelRuntime.run("selection", select) : select());
}

export async function cycleModel(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekCycleModelResult | null> {
  const target = context.writableTarget(sessionKey);
  const cycle = () => target.client.call({ type: "cycle_model" });
  return await (target.modelRuntime ? target.modelRuntime.run("selection", cycle) : cycle());
}

export async function setThinkingLevel(
  context: NekAgentCommandContext,
  input: { sessionKey: string; level: NekThoughtLevel },
): Promise<void> {
  await context
    .writableTarget(input.sessionKey)
    .client.call({ type: "set_thinking_level", level: input.level });
}

export async function cycleThinkingLevel(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ level: NekThinkingLevel } | null> {
  return await context.writableTarget(sessionKey).client.call({ type: "cycle_thinking_level" });
}

export async function getStats(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekSessionStats> {
  return await context.writableTarget(sessionKey).client.call({ type: "get_session_stats" });
}

export async function reload(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekReloadResult> {
  const target = context.writableTarget(sessionKey);
  return await (target.modelRuntime
    ? target.modelRuntime.reload()
    : target.client.call({ type: "reload" }));
}

/** nek 没有独立的模式命令，走 `extension_call nek.set_mode`。 */
export async function setMode(
  context: NekAgentCommandContext,
  input: { sessionKey: string; mode: NekMode },
): Promise<unknown> {
  return (
    await context.writableTarget(input.sessionKey).client.call({
      type: "extension_call",
      method: "nek.set_mode",
      params: { mode: input.mode },
    })
  ).result;
}

const SUBAGENT_STATUSES: readonly NekSubagentRecord["status"][] = [
  "running",
  "completed",
  "errored",
  "aborted",
];

/** 停止子代理；nek 只回新状态，形状不对就报错而不是把 `undefined` 交给界面。 */
export async function stopSubagent(
  context: NekAgentCommandContext,
  input: { sessionKey: string; id: string },
): Promise<{ status: NekSubagentRecord["status"] }> {
  const result = (
    await context.writableTarget(input.sessionKey).client.call({
      type: "extension_call",
      method: "nek.stop_subagent",
      params: { id: input.id },
    })
  ).result as { status?: unknown };
  const status = result?.status;
  if (!SUBAGENT_STATUSES.includes(status as NekSubagentRecord["status"])) {
    throw new Error(`nek returned an invalid subagent status: ${String(status)}`);
  }
  return { status: status as NekSubagentRecord["status"] };
}

/** 子会话消息原样透传；`messages` 必须是数组。 */
export async function getSubagentTranscript(
  context: NekAgentCommandContext,
  input: { sessionKey: string; id: string },
): Promise<{ messages: unknown[] }> {
  const result = (
    await context.target(input.sessionKey).client.call({
      type: "extension_call",
      method: "nek.get_subagent_transcript",
      params: { id: input.id },
    })
  ).result as { messages?: unknown };
  if (!Array.isArray(result?.messages)) {
    throw new Error(`nek returned an invalid subagent transcript for ${input.id}`);
  }
  return { messages: result.messages };
}

/** 可用子代理类型（内置 / 用户 / 项目三种来源）。 */
export async function listAgentTypes(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ types: NekAgentTypeInfo[] }> {
  const result = (
    await context.target(sessionKey).client.call({
      type: "extension_call",
      method: "nek.list_agent_types",
    })
  ).result as { types?: unknown };
  if (!Array.isArray(result?.types)) throw new Error("nek returned an invalid agent type list");
  return { types: result.types as NekAgentTypeInfo[] };
}

export async function getCommands(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekRpcSlashCommand[]> {
  return (await context.writableTarget(sessionKey).client.call({ type: "get_commands" })).commands;
}

/**
 * 会话条目（`fork` / `navigateTree` / `setEntryLabel` 需要 entryId）。
 *
 * 分页参数原样透传：`limit` 取最新的一页，配 `beforeEntryId` 取比该条目更旧的一页，
 * `hasMore` 说明还有更旧的条目。早于 P2c 的 nek 忽略这两个参数、返回完整列表，
 * 此时 `hasMore` 缺省——完整列表之后没有更旧的条目，按 false 报告是准确的。
 */
export async function getEntries(
  context: NekAgentCommandContext,
  input: { sessionKey: string; since?: string; limit?: number; beforeEntryId?: string },
): Promise<{ entries: NekSessionEntry[]; leafId: string | null; hasMore: boolean }> {
  const data = await context.target(input.sessionKey).client.call({
    type: "get_entries",
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.beforeEntryId === undefined ? {} : { beforeEntryId: input.beforeEntryId }),
  });
  return { entries: data.entries, leafId: data.leafId, hasMore: data.hasMore === true };
}

/** 分支树：navigateTree 的候选条目。 */
export async function getTree(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ tree: NekSessionTreeNode[]; leafId: string | null }> {
  return await context.target(sessionKey).client.call({ type: "get_tree" });
}

/** fork 时可回退到的用户消息。 */
export async function getForkMessages(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<Array<{ entryId: string; text: string }>> {
  return (await context.target(sessionKey).client.call({ type: "get_fork_messages" })).messages;
}

/** 会话存在时问会话进程（带 cwd 上下文），否则问控制进程。 */
export async function getMentionTargets(
  context: NekAgentCommandContext,
  input: { sessionKey?: string; cwd?: string } | string,
): Promise<NekMentionTargetInfo[]> {
  const value = typeof input === "string" ? { sessionKey: input } : input;
  if (value.sessionKey) {
    return (await context.target(value.sessionKey).client.call({ type: "get_mention_targets" }))
      .targets;
  }
  return (await (await context.control()).call({ type: "get_mention_targets", cwd: value.cwd }))
    .targets;
}

export async function navigateTree(
  context: NekAgentCommandContext,
  input: {
    sessionKey: string;
    entryId: string;
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  },
): Promise<{ cancelled: boolean; editorText?: string }> {
  return await context.writableTarget(input.sessionKey).client.call({
    type: "navigate_tree",
    entryId: input.entryId,
    summarize: input.summarize,
    customInstructions: input.customInstructions,
    replaceInstructions: input.replaceInstructions,
    label: input.label,
  });
}

export async function setEntryLabel(
  context: NekAgentCommandContext,
  input: { sessionKey: string; entryId: string; label?: string },
): Promise<void> {
  await context.writableTarget(input.sessionKey).client.call({
    type: "set_entry_label",
    entryId: input.entryId,
    label: input.label,
  });
}

export async function fork(
  context: NekAgentCommandContext,
  input: { sessionKey: string; entryId: string },
): Promise<{ text: string; cancelled: boolean }> {
  return await context
    .writableTarget(input.sessionKey)
    .client.call({ type: "fork", entryId: input.entryId });
}

export async function clone(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ cancelled: boolean }> {
  return await context.writableTarget(sessionKey).client.call({ type: "clone" });
}

export async function exportSession(
  context: NekAgentCommandContext,
  input: { sessionKey: string; format: "html" | "jsonl"; outputPath?: string },
): Promise<{ path: string }> {
  return await context.writableTarget(input.sessionKey).client.call({
    type: "export_session",
    format: input.format,
    outputPath: input.outputPath,
  });
}

export async function shareSession(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ url: string }> {
  return await context.writableTarget(sessionKey).client.call({ type: "share_session" });
}

export async function importSession(
  context: NekAgentCommandContext,
  input: { inputPath: string; cwd: string },
): Promise<{ sessionPath: string }> {
  return await (await context.control()).call({ type: "import_session", ...input });
}

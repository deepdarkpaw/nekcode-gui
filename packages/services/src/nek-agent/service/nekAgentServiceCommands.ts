import { randomUUID } from "node:crypto";
import type {
  NekBashResult,
  NekCompactionResult,
  NekCycleModelResult,
  NekImageContent,
  NekMentionTargetInfo,
  NekModel,
  NekReloadResult,
  NekRpcSlashCommand,
  NekSessionStats,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import type { NekRpcClient } from "../nekRpcClient.js";
import type { NekConversationProjector } from "../nekConversationProjector.js";
import type { NekMode, NekPromptInput, NekThoughtLevel } from "./types.js";

export interface NekAgentCommandTarget {
  client: NekRpcClient;
  projector?: NekConversationProjector;
  phase: "idle" | "running" | "waiting_input" | "error" | "locked";
  setPhase: (phase: "idle" | "running" | "waiting_input" | "error" | "locked") => void;
}

export interface NekAgentCommandContext {
  writableTarget: (sessionKey: string) => NekAgentCommandTarget;
  target: (sessionKey: string) => NekAgentCommandTarget;
  control: () => Promise<NekRpcClient>;
}

/** 空闲发 `prompt`；运行中按 `streamingBehavior` 发 `steer` 或 `follow_up`。 */
export async function sendPrompt(
  context: NekAgentCommandContext,
  input: NekPromptInput,
): Promise<{ disposition: string }> {
  const target = context.writableTarget(input.sessionKey);
  const images = input.images as NekImageContent[] | undefined;
  if (target.phase === "running" || target.phase === "waiting_input") {
    if (!input.streamingBehavior)
      throw new Error("streamingBehavior is required while nek is running");
    if (input.streamingBehavior === "steer")
      return await target.client.call({
        type: "steer",
        message: input.message,
        ...(images ? { images } : {}),
      });
    return await target.client.call({
      type: "follow_up",
      message: input.message,
      ...(images ? { images } : {}),
    });
  }
  const result = await target.client.call({
    type: "prompt",
    message: input.message,
    ...(images ? { images } : {}),
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

export async function clearQueue(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ steering: string[]; followUp: string[] }> {
  return await context.writableTarget(sessionKey).client.call({ type: "clear_queue" });
}

/**
 * 取回排队输入：nek 只有 `clear_queue`（返回并清空），没有只读的 peek 命令，
 * 因此取回与清空共用同一次 RPC，调用方拿到的就是队列内容。
 */
export async function retrieveQueue(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ steering: string[]; followUp: string[] }> {
  return await clearQueue(context, sessionKey);
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
  return await context.writableTarget(input.sessionKey).client.call({
    type: "set_model",
    provider: input.provider,
    modelId: input.modelId,
  });
}

export async function cycleModel(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekCycleModelResult | null> {
  return await context.writableTarget(sessionKey).client.call({ type: "cycle_model" });
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
  return await context.writableTarget(sessionKey).client.call({ type: "reload" });
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

export async function getCommands(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekRpcSlashCommand[]> {
  return (await context.writableTarget(sessionKey).client.call({ type: "get_commands" })).commands;
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

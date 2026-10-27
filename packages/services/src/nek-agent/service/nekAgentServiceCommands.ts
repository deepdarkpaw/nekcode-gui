import { randomUUID } from "node:crypto";
import type {
  NekBashResult,
  NekCompactionResult,
  NekMentionTargetInfo,
  NekModel,
  NekPromptImage,
  NekSessionStats,
} from "@zcode/shared/nek-protocol";
import type { NekRpcClient } from "../nekRpcClient.js";
import type { NekConversationProjector } from "../nekConversationProjector.js";
import type {
  NekMode,
  NekPromptInput,
  NekSessionProcessCreateOptions,
  NekThoughtLevel,
} from "./types.js";

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

export async function sendPrompt(
  context: NekAgentCommandContext,
  input: NekPromptInput,
): Promise<{ disposition: string }> {
  const target = context.writableTarget(input.sessionKey);
  const images = input.images as NekPromptImage[] | undefined;
  if (target.phase === "running" || target.phase === "waiting_input") {
    if (!input.streamingBehavior) throw new Error("streamingBehavior is required while nek is running");
    const command = input.streamingBehavior === "steer" ? "steer" : "follow_up";
    return (await target.client.call({
      type: command,
      message: input.message,
      ...(images ? { images } : {}),
    } as never)) as { disposition: string };
  }
  const result = (await target.client.call({
    type: "prompt",
    message: input.message,
    ...(images ? { images } : {}),
  })) as { disposition: string };
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

export async function abortBash(context: NekAgentCommandContext, sessionKey: string): Promise<void> {
  await context.writableTarget(sessionKey).client.call({ type: "abort_bash" });
}

export async function clearQueue(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<{ steering: string[]; followUp: string[] }> {
  return await context.writableTarget(sessionKey).client.call({ type: "clear_queue" });
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
  return (await context.writableTarget(input.sessionKey).client.call({
    type: "set_model",
    provider: input.provider,
    modelId: input.modelId,
  })) as NekModel;
}

export async function cycleModel(context: NekAgentCommandContext, sessionKey: string): Promise<unknown> {
  return await context.writableTarget(sessionKey).client.call({ type: "cycle_model" });
}

export async function setThinkingLevel(
  context: NekAgentCommandContext,
  input: { sessionKey: string; level: NekThoughtLevel },
): Promise<void> {
  await context.writableTarget(input.sessionKey).client.call({ type: "set_thinking_level", level: input.level as never });
}

export async function cycleThinkingLevel(context: NekAgentCommandContext, sessionKey: string): Promise<unknown> {
  return await context.writableTarget(sessionKey).client.call({ type: "cycle_thinking_level" });
}

export async function getStats(context: NekAgentCommandContext, sessionKey: string): Promise<NekSessionStats> {
  return await context.writableTarget(sessionKey).client.call({ type: "get_session_stats" });
}

export async function reload(context: NekAgentCommandContext, sessionKey: string): Promise<unknown> {
  return await context.writableTarget(sessionKey).client.call({ type: "reload" });
}

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

export async function getCommands(context: NekAgentCommandContext, sessionKey: string): Promise<unknown[]> {
  return (await context.writableTarget(sessionKey).client.call({ type: "get_commands" })).commands;
}

export async function getMentionTargets(
  context: NekAgentCommandContext,
  input: { sessionKey?: string; cwd?: string } | string,
): Promise<NekMentionTargetInfo[]> {
  const value = typeof input === "string" ? { sessionKey: input } : input;
  if (value.sessionKey) {
    return (await context.writableTarget(value.sessionKey).client.call({ type: "get_mention_targets" })).targets;
  }
  return (await context.control()).call({ type: "get_mention_targets", cwd: value.cwd }).then((result) => result.targets);
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
  return (await context.writableTarget(input.sessionKey).client.call({
    type: "navigate_tree",
    entryId: input.entryId,
    summarize: input.summarize,
    customInstructions: input.customInstructions,
    replaceInstructions: input.replaceInstructions,
    label: input.label,
  })) as { cancelled: boolean; editorText?: string };
}

export async function setEntryLabel(
  context: NekAgentCommandContext,
  input: { sessionKey: string; entryId: string; label?: string },
): Promise<void> {
  await context.writableTarget(input.sessionKey).client.call({ type: "set_entry_label", entryId: input.entryId, label: input.label });
}

export async function fork(
  context: NekAgentCommandContext,
  input: { sessionKey: string; entryId: string },
): Promise<{ text: string; cancelled: boolean }> {
  return await context.writableTarget(input.sessionKey).client.call({ type: "fork", entryId: input.entryId });
}

export async function clone(context: NekAgentCommandContext, sessionKey: string): Promise<{ cancelled: boolean }> {
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

export async function shareSession(context: NekAgentCommandContext, sessionKey: string): Promise<{ url: string }> {
  return await context.writableTarget(sessionKey).client.call({ type: "share_session" });
}

export async function importSession(
  context: NekAgentCommandContext,
  input: { inputPath: string; cwd: string },
): Promise<{ sessionPath: string }> {
  return await (await context.control()).call({ type: "import_session", ...input });
}

export function createProcessOptions(
  sessionKey: string,
  cwd: string,
  sessionPath?: string,
  approve?: boolean,
): NekSessionProcessCreateOptions {
  return { sessionKey, cwd, ...(sessionPath ? { sessionPath } : {}), ...(approve === undefined ? {} : { approve }) };
}

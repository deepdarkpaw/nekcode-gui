import type { NekMode, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import type { CommandAck, CommandsQueryResult } from "@zcode/shared/zcode-protocol-v4";
import type { NekSessionResult } from "../service/types.js";
import { toNekImages } from "./attachmentImages.js";
import { forkUserMessage } from "./nekForkUserMessage.js";
import {
  acceptedCommand,
  asRecord,
  readString,
  unsupportedCommand,
  workspaceKey,
} from "./frameHelpers.js";
import type { NekSessionBinding, NekSessionCommandEnvelope, NekWorkspaceTarget } from "./types.js";
import type { NekAgentService } from "../service/nekAgentService.js";

const THOUGHT_LEVELS: readonly NekThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface NekCommandContext {
  service: NekAgentService;
  createSession(input: {
    workspacePath: string;
    model?: { provider: string; modelId: string };
    thinking?: NekThinkingLevel;
    mode?: NekMode;
  }): Promise<NekSessionResult>;
  bindSession(target: NekWorkspaceTarget, result: NekSessionResult): void;
  ensureBinding(target: NekWorkspaceTarget, sessionId: string): Promise<NekSessionBinding>;
  removeBinding(target: NekWorkspaceTarget, sessionId: string): void;
}

/** 命令对账与发送共用绑定 admission，时钟查询不打开任何会话。 */
export async function queryConversationCommands(
  context: Pick<NekCommandContext, "service" | "ensureBinding">,
  input: {
    target: NekWorkspaceTarget;
    commands: Array<{ sessionId: string | null; commandId: string }>;
    clock?: true;
  },
): Promise<CommandsQueryResult> {
  if (input.clock) {
    const now = Date.now();
    return {
      results: input.commands.map((key) => ({ key, result: "unknown" as const })),
      clock: { instanceId: `nek:${workspaceKey(input.target)}`, receivedAt: now, sentAt: now },
    };
  }
  for (const command of input.commands) {
    if (!command.sessionId) continue;
    const binding = await context.ensureBinding(input.target, command.sessionId);
    await context.service.getCommands(binding.sessionKey);
  }
  return { results: input.commands.map((key) => ({ key, result: "unknown" as const })) };
}

export async function sendConversationCommand(
  context: NekCommandContext,
  input: { target: NekWorkspaceTarget; envelope: NekSessionCommandEnvelope },
): Promise<CommandAck> {
  const { envelope } = input;
  const payload = asRecord(envelope.payload) ?? {};
  if (envelope.type === "createSession")
    return await createFromCommand(context, input.target, envelope, payload);
  if (!envelope.sessionId) return unsupportedCommand(envelope, "sessionId is required");
  const binding = await context.ensureBinding(input.target, envelope.sessionId);
  const revision = context.service.conversationSnapshot(binding.sessionKey).revision;
  switch (envelope.type) {
    case "forkUserMessage":
      return await forkUserMessage(context, input.target, binding, envelope);
    case "sendText": {
      await applySelection(context.service, binding.sessionKey, payload);
      const images = await toNekImages(payload.attachments);
      const delivery = await prepareDelivery(context.service, binding.sessionKey, payload);
      const result = await context.service.sendPrompt({
        sessionKey: binding.sessionKey,
        message: readString(payload, "text") ?? "",
        ...(images ? { images } : {}),
        streamingBehavior: delivery,
      });
      return acceptedCommand(envelope, revision, {
        type: "inputAccepted",
        delivery: acceptedDelivery(result.disposition, delivery),
        inputId: envelope.commandId,
      });
    }
    case "sendGoalCommand": {
      await applySelection(context.service, binding.sessionKey, payload);
      const delivery = await prepareDelivery(context.service, binding.sessionKey, payload);
      const result = await context.service.sendPrompt({
        sessionKey: binding.sessionKey,
        message: readString(payload, "text") ?? "",
        streamingBehavior: delivery,
      });
      return acceptedCommand(envelope, revision, {
        type: "inputAccepted",
        delivery: acceptedDelivery(result.disposition, delivery),
        inputId: envelope.commandId,
      });
    }
    case "stop":
      await context.service.abort(binding.sessionKey);
      return acceptedCommand(envelope, revision);
    case "compact":
      await context.service.compact({ sessionKey: binding.sessionKey });
      return acceptedCommand(envelope, revision);
    case "switchModelConfig":
      await context.service.setModel({
        sessionKey: binding.sessionKey,
        provider: readString(payload, "provider") ?? "",
        modelId: readString(payload, "model") ?? "",
      });
      await setThoughtFromPayload(context.service, binding.sessionKey, payload);
      return acceptedCommand(envelope, revision);
    case "switchCollaborationMode":
      await setModeFromPayload(context.service, binding.sessionKey, payload);
      return acceptedCommand(envelope, revision);
    case "setFollowupMode":
      await context.service
        .commandContext()
        .writableTarget(binding.sessionKey)
        .client.call({
          type: "set_follow_up_mode",
          mode: readString(payload, "mode") === "guide" ? "all" : "one-at-a-time",
        });
      return acceptedCommand(envelope, revision);
    case "renameSession":
      await context.service.renameSession({
        sessionKey: binding.sessionKey,
        name: readString(payload, "title") ?? "",
      });
      return acceptedCommand(envelope, revision);
    case "deleteSession":
      await context.service.deleteSession({ sessionKey: binding.sessionKey });
      context.removeBinding(input.target, envelope.sessionId);
      return acceptedCommand(envelope, revision);
    default:
      return unsupportedCommand(envelope, "the corresponding nek RPC does not exist");
  }
}

async function createFromCommand(
  context: NekCommandContext,
  target: NekWorkspaceTarget,
  envelope: NekSessionCommandEnvelope,
  payload: Record<string, unknown>,
): Promise<CommandAck> {
  const firstInput = asRecord(payload.firstInput);
  const config = asRecord(payload.config);
  const model = asRecord(firstInput?.modelSelection ?? config?.modelSelection);
  const thinking = selectionThinking(model, config);
  const requestedMode = submissionMode(firstInput) ?? submissionMode(config);
  const result = await context.createSession({
    workspacePath: target.workspacePath,
    ...(model ? { model: modelSelectionOf(model) } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(requestedMode !== undefined ? { mode: mode(requestedMode) } : {}),
  });
  if (firstInput) {
    const images = await toNekImages(firstInput.attachments);
    await context.service.sendPrompt({
      sessionKey: result.sessionKey,
      message: readString(firstInput, "text") ?? "",
      ...(images ? { images } : {}),
    });
  }
  return acceptedCommand(envelope, result.conversation.revision, {
    type: "createSession",
    sessionId: result.sessionId,
    ...(firstInput ? { input: { delivery: "startNow", inputId: envelope.commandId } } : {}),
  });
}

/**
 * 协议里的 ModelSelection 用 `providerId`，nek 的 `set_model` / 会话创建用 `provider`。
 *
 * 这里只做字段改名：漏读 `providerId` 会让 nek 收到 `/{modelId}`，首发直接被
 * `Model not found` 拒绝。
 */
function modelSelectionOf(model: Record<string, unknown>): {
  provider: string;
  modelId: string;
} {
  const providerId = readString(model, "providerId");
  const modelId = readString(model, "modelId");
  if (!providerId || !modelId) {
    throw new Error(`invalid model selection: provider=${providerId ?? ""} model=${modelId ?? ""}`);
  }
  return { provider: providerId, modelId };
}

type StreamingBehavior = "steer" | "follow_up";

function isBusy(service: NekAgentService, sessionKey: string): boolean {
  const phase = service.getSession(sessionKey)?.phase;
  return phase === "running" || phase === "waiting_input";
}

/**
 * v4 `requestedDelivery` → nek 运行中的投递方式，与 CLI 一致：
 * - 缺省 / `guide`：Enter，`steer`（当前工具调用结束后插入）；
 * - `queue`：Alt+Enter，`follow_up`（本轮结束后再发）；
 * - `startNow`：先中止当前轮，再作为新 prompt 发出。
 * 空闲时 `sendPrompt` 忽略该值，直接发 `prompt`。
 */
async function prepareDelivery(
  service: NekAgentService,
  sessionKey: string,
  payload: Record<string, unknown>,
): Promise<StreamingBehavior> {
  const requested = readString(payload, "requestedDelivery");
  if (requested === "queue") return "follow_up";
  if (requested === "startNow" && isBusy(service, sessionKey)) await service.abort(sessionKey);
  return "steer";
}

function acceptedDelivery(
  disposition: string,
  behavior: StreamingBehavior,
): "startNow" | "queue" | "guide" {
  if (disposition === "started") return "startNow";
  return behavior === "steer" ? "guide" : "queue";
}

async function applySelection(
  service: NekAgentService,
  sessionKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const model = asRecord(payload.modelSelection);
  const thinking = selectionThinking(model, payload);
  if (model) {
    await service.setModel({ sessionKey, ...modelSelectionOf(model) });
  }
  // set_model 会按模型支持等级夹取旧值，必须在它之后应用本次输入框的明确选择。
  if (thinking !== undefined) await service.setThinkingLevel({ sessionKey, level: thinking });
  const requestedMode = submissionMode(payload);
  if (requestedMode !== undefined) await service.setMode({ sessionKey, mode: requestedMode });
}

async function setModeFromPayload(
  service: NekAgentService,
  sessionKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await service.setMode({ sessionKey, mode: mode(readString(payload, "mode")) });
}

async function setThoughtFromPayload(
  service: NekAgentService,
  sessionKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await service.setThinkingLevel({
    sessionKey,
    level: thoughtLevel(readString(payload, "thought")),
  });
}

/** canonical Selection 优先于旧 thought 字段；缺省不覆盖 nek 自己的设置。 */
function selectionThinking(
  model: Record<string, unknown> | undefined,
  payload: Record<string, unknown> | undefined,
): NekThinkingLevel | undefined {
  const options = asRecord(model?.options);
  const requested = options?.reasoningLevel ?? payload?.thought;
  if (requested === undefined) return undefined;
  return thoughtLevel(typeof requested === "string" ? requested : undefined);
}

/** v4 用 agent + planEnabled 表达 Plan；nek 只有 agent/plan 两档，必须在接纳边界转换。 */
function submissionMode(payload: Record<string, unknown> | undefined): NekMode | undefined {
  if (typeof payload?.planEnabled === "boolean") return payload.planEnabled ? "plan" : "agent";
  const requested = readString(payload ?? {}, "mode");
  return requested === undefined ? undefined : mode(requested);
}

function mode(value: string | undefined): NekMode {
  if (value === "agent" || value === "plan") return value;
  throw new Error(`invalid nek mode: ${value ?? "missing"}`);
}

function thoughtLevel(value: string | undefined): NekThinkingLevel {
  if (value && THOUGHT_LEVELS.includes(value as NekThinkingLevel)) return value as NekThinkingLevel;
  throw new Error(`invalid nek thinking level: ${value ?? "missing"}`);
}

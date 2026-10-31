import type { NekMode, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { NekSessionResult } from "../service/types.js";
import { toNekImages } from "./attachmentImages.js";
import { acceptedCommand, asRecord, readString, unsupportedCommand } from "./frameHelpers.js";
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
  requireBinding(target: NekWorkspaceTarget, sessionId: string): NekSessionBinding;
  removeBinding(target: NekWorkspaceTarget, sessionId: string): void;
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
  const binding = context.requireBinding(input.target, envelope.sessionId);
  const revision = context.service.conversationSnapshot(binding.sessionKey).revision;
  switch (envelope.type) {
    case "sendText": {
      await applySelection(context.service, binding.sessionKey, payload);
      const images = await toNekImages(payload.attachments);
      const requestedDelivery = readString(payload, "requestedDelivery");
      const result = await context.service.sendPrompt({
        sessionKey: binding.sessionKey,
        message: readString(payload, "text") ?? "",
        ...(images ? { images } : {}),
        ...(requestedDelivery === "queue" ? { streamingBehavior: "follow_up" as const } : {}),
      });
      return acceptedCommand(envelope, revision, {
        type: "inputAccepted",
        delivery: result.disposition === "started" ? "startNow" : "queue",
        inputId: envelope.commandId,
      });
    }
    case "sendGoalCommand": {
      await applySelection(context.service, binding.sessionKey, payload);
      const result = await context.service.sendPrompt({
        sessionKey: binding.sessionKey,
        message: readString(payload, "text") ?? "",
      });
      return acceptedCommand(envelope, revision, {
        type: "inputAccepted",
        delivery: result.disposition === "started" ? "startNow" : "queue",
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
  const result = await context.createSession({
    workspacePath: target.workspacePath,
    ...(model ? { model: modelSelectionOf(model) } : {}),
    ...(readString(config ?? {}, "thought")
      ? { thinking: thoughtLevel(readString(config ?? {}, "thought")) }
      : {}),
    ...(readString(config ?? {}, "mode") ? { mode: mode(readString(config ?? {}, "mode")) } : {}),
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

async function applySelection(
  service: NekAgentService,
  sessionKey: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const model = asRecord(payload.modelSelection);
  if (model) {
    await service.setModel({ sessionKey, ...modelSelectionOf(model) });
  }
  if (readString(payload, "mode")) await setModeFromPayload(service, sessionKey, payload);
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

function mode(value: string | undefined): NekMode {
  if (value === "agent" || value === "plan") return value;
  throw new Error(`invalid nek mode: ${value ?? "missing"}`);
}

function thoughtLevel(value: string | undefined): NekThinkingLevel {
  if (value && THOUGHT_LEVELS.includes(value as NekThinkingLevel)) return value as NekThinkingLevel;
  throw new Error(`invalid nek thinking level: ${value ?? "missing"}`);
}

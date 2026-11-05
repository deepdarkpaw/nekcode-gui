import { randomUUID } from "node:crypto";
import type {
  CommandAck,
  ConversationTopicFrame,
  SessionsIndexTopicFrame,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  encodeTopicWireFrames,
  measureTopicNotificationEnvelopeBytes,
  type TopicWireFrame,
} from "@zcode/shared/zcode-protocol-v4";
import type { NekWorkspaceTarget, NekSessionCommandEnvelope } from "./types.js";

export function workspaceKey(target: NekWorkspaceTarget): string {
  const identity = target.workspaceIdentity?.trim();
  return identity || target.workspacePath;
}

export function sessionMapKey(target: NekWorkspaceTarget, sessionId: string): string {
  return `${target.workspacePath}\0${sessionId}`;
}

export function makeSubscriptionId(topic: string): string {
  return `nek:${topic}:${randomUUID()}`;
}

/** 按接收端相同的 envelope 预算分片；一个逻辑帧的所有物理片共享序号。 */
export function makeTopicWireFrames<
  F extends ConversationTopicFrame | SessionsIndexTopicFrame | WorkspaceConfigTopicFrame,
>(
  frame: F,
  subscriptionId: string,
  ordinal: number,
  deliveryKind: "initial" | "online" | "recovery",
): TopicWireFrame<F>[] {
  return encodeTopicWireFrames(
    { ...frame, subscriptionId },
    {
      deliveryKind,
      logicalFrameId: `${subscriptionId}:${frame.toSeq}:${ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic: frame.topic,
      subscriptionId,
      measurePhysicalFrameBytes: (wire) => measureTopicNotificationEnvelopeBytes(wire).maxBytes,
    },
  );
}

export function acceptedCommand(
  envelope: NekSessionCommandEnvelope,
  revisionAtDecision: number,
  result?: CommandAck["result"],
): CommandAck {
  return {
    commandId: envelope.commandId,
    status: "accepted",
    revisionAtDecision,
    ...(result ? { result } : {}),
  };
}

export function unsupportedCommand(envelope: NekSessionCommandEnvelope, message: string): never {
  throw new Error(`nek command ${envelope.type} is unavailable: ${message}`);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

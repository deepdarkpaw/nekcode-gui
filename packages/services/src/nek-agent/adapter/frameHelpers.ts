import { randomUUID } from "node:crypto";
import type {
  CommandAck,
  ConversationTopicFrame,
  SessionsIndexTopicFrame,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationTopicWireCandidate,
  SessionsIndexTopicWireCandidate,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { NekWorkspaceTarget, NekSessionCommandEnvelope } from "./types.js";

export function workspaceKey(target: NekWorkspaceTarget): string {
  const identity = target.workspaceIdentity?.trim();
  return identity || target.workspacePath;
}

export function sessionMapKey(target: NekWorkspaceTarget, sessionId: string): string {
  return `${workspaceKey(target)}\0${sessionId}`;
}

export function makeSubscriptionId(topic: string): string {
  return `nek:${topic}:${randomUUID()}`;
}

export function makeWireFrame(
  frame: ConversationTopicFrame,
  subscriptionId: string,
  ordinal: number,
  deliveryKind: "initial" | "online" | "recovery",
): ConversationTopicWireCandidate {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `${subscriptionId}:${frame.toSeq}:${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: frame.topic,
    subscriptionId,
    frame: { ...frame, subscriptionId },
  };
}

export function makeSessionsIndexWireFrame(
  frame: SessionsIndexTopicFrame,
  subscriptionId: string,
  ordinal: number,
  deliveryKind: "initial" | "online" | "recovery",
): SessionsIndexTopicWireCandidate {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `${subscriptionId}:${frame.toSeq}:${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: frame.topic,
    subscriptionId,
    frame: { ...frame, subscriptionId },
  };
}

export function makeWorkspaceConfigWireFrame(
  frame: WorkspaceConfigTopicFrame,
  subscriptionId: string,
  ordinal: number,
  deliveryKind: "initial" | "online" | "recovery",
): WorkspaceConfigTopicWireCandidate {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind,
    logicalFrameId: `${subscriptionId}:${frame.toSeq}:${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: frame.topic,
    subscriptionId,
    frame: { ...frame, subscriptionId },
  };
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
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

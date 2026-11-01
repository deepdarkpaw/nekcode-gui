import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { NekCommandContext } from "./nekAgentServiceAdapterCommands.js";
import type { NekSessionBinding, NekSessionCommandEnvelope, NekWorkspaceTarget } from "./types.js";
import { acceptedCommand, asRecord } from "./frameHelpers.js";

/** Resolve only the exact persisted user row; never guess from assistant text or timestamps. */
export async function forkUserMessage(
  context: NekCommandContext,
  target: NekWorkspaceTarget,
  binding: NekSessionBinding,
  envelope: NekSessionCommandEnvelope,
): Promise<CommandAck> {
  const snapshot = context.service.conversationSnapshot(binding.sessionKey);
  const reject = (reasonCode: string): CommandAck => ({
    commandId: envelope.commandId,
    status: "stale",
    reasonCode,
    revisionAtDecision: snapshot.revision,
  });
  if (envelope.baseLogEpoch !== snapshot.logEpoch) return reject("guard.logEpochMismatch");
  if (envelope.baseRevision !== snapshot.revision) return reject("guard.revisionMismatch");
  const rowTarget = asRecord(asRecord(envelope.payload)?.target);
  const row = snapshot.rows.window.find(
    (item) => item.rowId === rowTarget?.rowId && item.entityId === rowTarget?.entityId,
  );
  if (row?.kind !== "userInput" || row.actions?.canFork !== true || !row.entityId)
    return reject("guard.forkUserMessageOnly");
  const match = /^entry:(.+):user$/u.exec(row.entityId);
  if (!match?.[1]) return reject("guard.forkUserMessageOnly");
  const result = await context.service.forkSession({
    sessionKey: binding.sessionKey,
    entryId: match[1],
  });
  if (result.cancelled) return { ...reject("guard.forkCancelled"), status: "noop" };
  context.removeBinding(target, binding.sessionId);
  context.bindSession(target, result.session);
  return acceptedCommand(envelope, snapshot.revision, {
    type: "forkUserMessage",
    sessionId: result.session.sessionId,
    text: result.text,
  });
}

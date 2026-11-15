import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { NekCommandContext } from "./nekAgentServiceAdapterCommands.js";
import type { NekSessionBinding, NekSessionCommandEnvelope, NekWorkspaceTarget } from "./types.js";
import { historyRowId } from "../projection/nekHistoryIdentity.js";
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
  const entity = typeof rowTarget?.entityId === "string" ? rowTarget.entityId : "";
  const match = /^entry:(.+):user$/u.exec(entity);
  if (!match?.[1]) return reject("guard.forkUserMessageOnly");
  if (row) {
    if (row.kind !== "userInput" || row.actions?.canFork !== true)
      return reject("guard.forkUserMessageOnly");
  } else {
    if (!snapshot.history || snapshot.rows.window.some((item) => item.entityId === entity))
      return reject("guard.forkUserMessageOnly");
    const authorized = await context.service.runHistoryRead(
      binding.sessionKey,
      undefined,
      async (history) => {
        const page = await history.read({
          type: "read_history_page",
          view: "target",
          aroundEntryId: match[1],
          turnLimit: 1,
        });
        const user = page.turns.find((turn) => turn.userEntryId === match[1])?.header;
        return (
          page.view === "target" &&
          user?.role === "user" &&
          user.id === match[1] &&
          historyRowId(user.position, 1) === rowTarget?.rowId &&
          (history.observedEntries === undefined || user.position < history.observedEntries)
        );
      },
    );
    if (!authorized) return reject("guard.forkUserMessageOnly");
    const current = context.service.conversationSnapshot(binding.sessionKey);
    if (current.logEpoch !== snapshot.logEpoch || current.revision !== snapshot.revision)
      return reject("guard.revisionMismatch");
  }
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

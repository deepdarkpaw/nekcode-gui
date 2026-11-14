import type {
  NekHistoryCommand,
  NekStoredAttachment,
  NekHistoryIdentity,
  NekHistoryCommandResult,
  NekHistoryResult,
  NekHistorySubagentRecord,
} from "@zcode/shared/nek-protocol";
import type {
  ConversationSnapshot,
  ConversationHistoryWatermark,
} from "@zcode/shared/zcode-protocol-v4";
import { NekAgentServiceRuntimeBase } from "./nekAgentServiceRuntimeMethods.js";
import {
  historyResult,
  requireHistoryPages,
  HISTORY_RPC_MAX_BYTES,
  NekHistoryReadError,
} from "./nekHistoryRpc.js";
import { findNekUserFile } from "../projection/nekUserFiles.js";
import { resolveNekSessionAttachment } from "./nekSessionAttachments.js";
import { isNekState } from "./types.js";
import type { NekRpcClient } from "../nekRpcClient.js";
import type { NekConversationProjector } from "../nekConversationProjector.js";

export interface NekHistoryReadContext {
  read<C extends NekHistoryCommand>(
    command: C,
  ): Promise<Extract<NekHistoryCommandResult<C>, { ok: true }>>;
  projector: NekConversationProjector;
  watermark: ConversationHistoryWatermark;
  snapshot: ConversationSnapshot;
  readonly: boolean;
  observedEntries?: number;
  child?: Pick<NekHistorySubagentRecord, "id" | "sessionFile" | "status"> &
    Partial<NekHistorySubagentRecord>;
}

/** Single admission path for writable/readonly/remote/child reads. No completed response cache. */
export abstract class NekHistoryServiceBase extends NekAgentServiceRuntimeBase {
  private historyFlights = 0;

  /** Authorize legacy file metadata without retaining a whole readonly source snapshot. */
  async readUserFile(sessionKey: string, ref: string): Promise<NekStoredAttachment> {
    const record = this.requireRecord(sessionKey);
    return await this.withSession(sessionKey, () =>
      resolveNekSessionAttachment(
        record,
        (entries) => findNekUserFile(record.sessionId, ref, entries),
        async () =>
          (record.readonly ? await this.pool.ensureControl() : this.requireProcess(record)).client,
        "file",
      ),
    );
  }

  async runHistoryRead<T>(
    sessionKey: string,
    subagentId: string | undefined,
    run: (context: NekHistoryReadContext) => Promise<T>,
  ): Promise<T> {
    this.assertAlive();
    if (subagentId !== undefined && (typeof subagentId !== "string" || !subagentId.trim()))
      throw new NekHistoryReadError("INVALID_REQUEST", "subagentId must be a nonempty child identity");
    if (this.historyFlights >= 16)
      throw new NekHistoryReadError("CAPACITY", "nek history request capacity exceeded (16)");
    this.historyFlights += 1;
    try {
      return await this.withSession(sessionKey, async () => {
        const record = this.requireRecord(sessionKey);
        const process = record.readonly
          ? await this.pool.ensureControl()
          : this.requireProcess(record);
        requireHistoryPages(process.guiInfo);
        const projector = record.projector;
        if (!projector) throw new Error("nek history projection is not loaded");
        projector.flushNow();
        const initial = projector.snapshot();
        const observedEntries = projector.observedHistoryEntries;
        const generation = record.historyGeneration;
        const epoch = record.stateEpoch;
        const path = record.path;
        const validate = () => {
          this.assertAlive();
          if (
            record.closing ||
            this.resolveRecord(sessionKey) !== record ||
            record.path !== path ||
            record.projector !== projector ||
            record.historyGeneration !== generation ||
            record.stateEpoch !== epoch ||
            projector.snapshot().logEpoch !== initial.logEpoch ||
            (record.readonly ? this.pool.control !== process : record.process !== process)
          )
            throw new NekHistoryReadError(
              "STALE_CURSOR",
              "nek history owner changed during read; refetch the target page",
            );
        };
        const parentPath = record.readonly ? path : undefined;
        if (record.readonly && !parentPath)
          throw new Error("readonly history has no trusted session path");
        const parentRead = makeHistoryReader(
          process.client,
          parentPath,
          record.sessionId,
          validate,
        );
        let child: NekHistoryReadContext["child"];
        let missing: unknown;
        if (subagentId) {
          try {
            child = (await parentRead({ type: "read_history_subagent", subagentId })).subagent;
          } catch (error) {
            if (!(error instanceof NekHistoryReadError) || error.code !== "NOT_FOUND") throw error;
            missing = error;
          }
        }
        if (subagentId && !record.readonly) {
          const extension = await process.client.call({
            type: "extension_call",
            method: "nek.get_state",
          });
          validate();
          if (!isNekState(extension.result))
            throw new Error("nek returned invalid live child registry");
          const live = extension.result.subagents.find((item) => item.id === subagentId);
          if (live)
            child = {
              ...child,
              id: live.id,
              status: live.status,
              sessionFile: live.sessionFile ?? child?.sessionFile,
            };
          else if (child?.status === "running") child = { ...child, status: "aborted" };
        }
        if (subagentId && !child)
          throw missing ?? new Error(`Unknown subagent ${subagentId} in parent session`);
        if (child && record.readonly && child.status === "running")
          child = { ...child, status: "aborted" };
        if (child && !child.sessionFile)
          throw new NekHistoryReadError(
            "NOT_FOUND",
            `Subagent ${subagentId} has no persisted bounded transcript; live child history requires CLI support`,
          );
        // Child paths originate only in the validated parent's persisted relation, never renderer input.
        const read = child
          ? makeHistoryReader(process.client, child.sessionFile, child.id, validate)
          : parentRead;
        const result = await run({
          read,
          projector,
          child,
          snapshot: initial,
          readonly: record.readonly,
          observedEntries,
          watermark: {
            atSeq: initial.seq,
            atRevision: initial.revision,
            atLogEpoch: initial.logEpoch,
          },
        });
        validate();
        return result;
      });
    } finally {
      this.historyFlights -= 1;
    }
  }
}

function makeHistoryReader(
  client: NekRpcClient,
  sessionPath: string | undefined,
  sessionId: string,
  validate: () => void,
): NekHistoryReadContext["read"] {
  return async <C extends NekHistoryCommand>(command: C) => {
    validate();
    const wire = await client.call({ ...command, sessionPath, maxBytes: HISTORY_RPC_MAX_BYTES });
    // Generic discriminated command/result correlation is enforced by the shared wire map.
    const result = historyResult(wire as NekHistoryResult<NekHistoryIdentity>);
    validate();
    if (result.sessionId !== sessionId)
      throw new NekHistoryReadError(
        "FOREIGN_CURSOR",
        "nek returned history for a different session",
      );
    if (command.type === "read_history_subagent") {
      const single = typeof command.subagentId === "string";
      if ((single && !("subagent" in result)) || (!single && (!("kind" in result) || result.kind !== "subagents")))
        throw new NekHistoryReadError("INVALID_RESPONSE", "nek child result does not match the requested query shape");
    }
    return result as Extract<NekHistoryCommandResult<C>, { ok: true }>;
  };
}

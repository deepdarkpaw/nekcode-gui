import type {
  NekHistoryEntry,
  NekHistoryPage,
  NekHistoryResponseData,
  NekHistorySubagent,
  NekHistorySubagentDirectory,
  NekHistorySubagentRecord,
} from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { validateHistoryDisplay } from "../projection/nekHistoryDisplay.js";
import { historyChildRowId } from "../projection/nekHistoryIdentity.js";
import { projectHistory, type ProjectableHistoryPage } from "../projection/nekHistoryProjection.js";
import { subagentRowFromRecord } from "../projection/nekProjectionSnapshot.js";
import { extractSubagentsFromToolResult } from "../projection/nekSubagentRecords.js";
import {
  HISTORY_PAGE_MAX_BYTES,
  HISTORY_RPC_MAX_BYTES,
  historyResult,
  historyTargetQuery,
  NekHistoryReadError,
} from "./nekHistoryRpc.js";

type OriginQuery = (
  | { type: "read_history_subagent"; subagentId: string }
  | { type: "read_history_page"; view: "target"; aroundEntryId: string; turnLimit: 1 }
) & { observationCursor: string; maxBytes: number };
type ReadOrigin = (query: OriginQuery) => Promise<NekHistoryResponseData[OriginQuery["type"]]>;

function invalid(message: string): never {
  throw new NekHistoryReadError("INVALID_RESPONSE", `Invalid subagent history origin: ${message}`);
}

/** A follow-up lookup shares the original page's signed prefix, but may observe later appends. */
function originReader(page: NekHistoryPage, read: ReadOrigin) {
  let count = 0;
  async function checked(query: OriginQuery) {
    if (++count > 128)
      throw new NekHistoryReadError("INDEX_LIMIT", "Too many subagent origin lookups in one page");
    const result = historyResult<NekHistoryPage | NekHistorySubagent | NekHistorySubagentDirectory>(
      await read(query),
    );
    if (result.sessionId !== page.sessionId || result.sessionPath !== page.sessionPath)
      throw new NekHistoryReadError(
        "FOREIGN_CURSOR",
        "Subagent origin belongs to a different session",
      );
    return result;
  }
  const observationCursor = page.observationCursor;
  return {
    async child(id: string) {
      const result = await checked({
        type: "read_history_subagent",
        subagentId: id,
        observationCursor,
        maxBytes: HISTORY_RPC_MAX_BYTES,
      });
      if (!("subagent" in result) || result.subagent.id !== id) invalid("wrong child identity");
      return result.subagent;
    },
    async target(id: string, position: number) {
      const result = await checked({ ...historyTargetQuery(id), observationCursor });
      if (
        !("view" in result) ||
        result.view !== "target" ||
        result.turns.length !== 1 ||
        result.entries.length > 2
      )
        invalid("expected a single target and its header");
      const entry = result.entries.find((item) => item.id === id);
      if (
        !entry ||
        entry.position !== position ||
        entry.entry.id !== id ||
        entry.turnId !== result.turns[0]!.id
      )
        invalid("wrong target entry or turn");
      return { page: result, entry };
    },
  };
}

/** A directory pointer is not itself a spawn: verify the entry body and child identity. */
function spawnAt(source: NekHistoryEntry, id: string) {
  const entry = validateHistoryDisplay(source.entry);
  if (
    entry.id !== source.id ||
    entry.type !== "message" ||
    entry.message.role !== "toolResult" ||
    entry.message.toolName !== "subagent"
  )
    invalid("original entry is not a subagent tool result");
  const { toolName, toolCallId, details } = entry.message;
  const spawned = extractSubagentsFromToolResult(toolName, toolCallId, details).find(
    (item) => item.record.id === id,
  );
  if (!spawned || !toolCallId) invalid("spawn result does not identify this child");
  const origin = source.toolCallOrigin;
  if (
    origin &&
    (origin.toolCallId !== toolCallId ||
      origin.name !== toolName ||
      origin.position >= source.position)
  )
    invalid("spawn tool mismatch");
  return { record: spawned.record, toolCallId, origin };
}

/** Resolve only the source identities needed by this page; never traverse intervening turns,
 * open a child file, or treat the resume/await/stop call as a new spawn. */
export async function prepareHistoryPage(
  page: NekHistoryPage,
  read: ReadOrigin,
  cached: () => readonly ConversationRow[] = () => [],
): Promise<ProjectableHistoryPage> {
  // Most live locator targets are not subagent results. Do not read their bodies or copy the anchor cache.
  const results = page.entries.filter((source) => {
    const message = source.entry.message;
    return (
      source.type === "message" &&
      typeof message === "object" &&
      message !== null &&
      "toolName" in message &&
      (message.toolName === "subagent" ||
        message.toolName === "await" ||
        message.toolName === "stop_subagent")
    );
  });
  if (!results.length) return page;
  const firstReference = new Map<string, number>();
  const summaries = new Map<string, NekHistorySubagentRecord>();
  const sources = new Map(page.entries.map((entry) => [entry.id, entry]));
  const cachedByEntity = new Map(cached().map((row) => [row.entityId, row]));
  const lookup = originReader(page, read);
  const seeds = new Map<string, ConversationRow>();
  let seedBytes = 0;
  function remember(key: string, row: ConversationRow) {
    seedBytes += Buffer.byteLength(JSON.stringify(row));
    if (seedBytes > HISTORY_PAGE_MAX_BYTES)
      throw new NekHistoryReadError(
        "RESPONSE_LIMIT",
        "Subagent origin seeds exceed the history page budget",
      );
    seeds.set(key, row);
  }

  async function toolOrigin(origin: NonNullable<NekHistoryEntry["toolCallOrigin"]>) {
    const key = `tool:${origin.toolCallId}`;
    const seeded = seeds.get(key);
    if (seeded) return seeded;
    const known = cachedByEntity.get(key);
    if (known?.kind === "toolCall" && known.toolName === origin.name) {
      const { output: _output, error: _error, ...anchor } = known;
      remember(key, anchor);
      return anchor;
    }
    const { page: owner, entry } = await lookup.target(origin.entryId, origin.position);
    if (entry.role !== "assistant") invalid("tool owner is not an assistant message");
    const tool = projectHistory({ ...owner, entries: [entry], targetEntryId: entry.id }).find(
      (row) =>
        row.kind === "toolCall" &&
        row.toolCallId === origin.toolCallId &&
        row.toolName === origin.name,
    );
    if (!tool) invalid("original tool call is missing");
    remember(key, tool);
    return tool;
  }

  for (const source of results) {
    const entry = validateHistoryDisplay(source.entry);
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      (source.role !== undefined && source.role !== "toolResult")
    )
      invalid("tool result wrapper mismatch");
    const message = entry.message;
    const records = extractSubagentsFromToolResult(
      message.toolName,
      message.toolCallId,
      message.details,
    );
    if (!records.length) continue;
    for (const { record } of records)
      if (!firstReference.has(record.id)) firstReference.set(record.id, source.position);
    for (const record of source.subagents ?? []) summaries.set(record.id, record);
    if (firstReference.size > 2048)
      throw new NekHistoryReadError("INDEX_LIMIT", "Too many child identities in one page");
    const origin = source.toolCallOrigin;
    if (origin && !sources.has(origin.entryId)) {
      if (
        origin.toolCallId !== message.toolCallId ||
        origin.name !== message.toolName ||
        origin.position >= source.position
      )
        invalid("mismatched tool call");
      await toolOrigin(origin);
    }
  }
  for (const [id, referencePosition] of firstReference) {
    const fact = summaries.get(id) ?? (await lookup.child(id));
    if (!fact.spawnEntryId || fact.spawnPosition > referencePosition)
      invalid("spawn does not precede its update");
    const rowId = historyChildRowId(fact.spawnPosition);
    const local = sources.get(fact.spawnEntryId);
    if (local) {
      if (local.position !== fact.spawnPosition) invalid("spawn position mismatch");
      spawnAt(local, id);
      continue; // Project the original result in source order with its owning tool.
    }
    const entity = `subagent:${id}`;
    const known = cachedByEntity.get(entity);
    if (
      known?.kind === "subagent" &&
      known.childSessionId === id &&
      known.parentToolCallId &&
      known.rowId === rowId
    )
      continue;
    const { entry: source, page: originPage } = await lookup.target(
      fact.spawnEntryId,
      fact.spawnPosition,
    );
    const { record, toolCallId, origin } = spawnAt(source, id);
    // A foreground result can land AFTER a later user input. Use the call's turn, not the result's.
    const turnId =
      origin && origin.position < originPage.turns[0]!.header.position
        ? (await toolOrigin(origin)).turnId
        : source.turnId;
    remember(entity, subagentRowFromRecord(entity, rowId, turnId, record, toolCallId));
  }
  return seeds.size ? { ...page, originAnchors: [...seeds.values()] } : page;
}

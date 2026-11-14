/** In-memory storage fixture for host tests only; production never slices whole history. */
import type {
  NekHistoryEntry,
  NekHistoryTurn,
  NekRpcCommand,
  NekSessionEntry,
  NekSessionSnapshot,
  NekSessionSummary,
} from "@zcode/shared/nek-protocol";
import { collectPersistedSubagentRecords } from "../src/nek-agent/projection/nekSubagentRecords.js";

export const historySummary: NekSessionSummary = {
  id: "s1",
  path: "/tmp/session.jsonl",
  cwd: "/workspace",
  createdAt: "2026-01-01T00:00:00Z",
  modifiedAt: "2026-01-01T00:00:00Z",
  messageCount: 0,
  firstMessage: "",
  locked: false,
};
export function fixtureHistory(
  entries: NekSessionEntry[],
  command: NekRpcCommand | { type: string },
  session = historySummary,
  lockedBy?: NekSessionSnapshot["lockedBy"],
): unknown {
  const identity = {
    ok: true as const,
    sessionId: session.id,
    sessionPath: session.path,
    branchRevision: `branch:${entries.length}`,
    observationCursor: `observation:${session.id}:${entries.length}`,
    leafId: entries.at(-1)?.id ?? null,
    watermark: { entryId: entries.length, conversationId: 1, nextSeq: entries.length },
  };
  let turnId = "preamble";
  const sources: NekHistoryEntry[] = entries.map((entry, position) => {
    if (entry.type === "message" && entry.message.role === "user") turnId = `turn:${entry.id}`;
    return {
      id: entry.id,
      parentId: entry.parentId,
      type: entry.type,
      timestamp: entry.timestamp,
      turnId,
      position,
      role: entry.type === "message" ? entry.message.role : undefined,
      preview:
        entry.type === "message" && typeof entry.message.content === "string"
          ? entry.message.content.slice(0, 256)
          : "",
      entry: { ...entry },
      omissions: [],
    };
  });
  const turns: NekHistoryTurn[] = [];
  for (const source of sources) {
    if (turns.at(-1)?.id === source.turnId) {
      turns.at(-1)!.entryCount += 1;
      continue;
    }
    turns.push({
      id: source.turnId,
      userEntryId: source.role === "user" ? source.id : null,
      position: source.position,
      preview: source.preview,
      entryCount: 1,
      header: source,
    });
  }
  if (command.type === "read_session_metadata") {
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
    const selection: { model?: { provider: string; modelId: string }; thinkingLevel?: string } = {};
    for (const entry of entries) {
      if (entry.type === "model_change")
        selection.model = { provider: entry.provider, modelId: entry.modelId };
      if (entry.type === "thinking_level_change") selection.thinkingLevel = entry.thinkingLevel;
      if (entry.type === "message" && entry.message.role === "assistant") {
        const value = entry.message.usage;
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
          usage[key] += value?.[key] ?? 0;
        usage.cost += value?.cost.total ?? 0;
      }
    }
    return {
      ...identity,
      session,
      lockedBy,
      totalTurns: turns.length,
      totalEntries: entries.length,
      selection,
      usage,
      children: { count: collectPersistedSubagentRecords(entries).size },
      status: "persisted",
    };
  }
  if (command.type === "read_history_page") {
    const query = command as Extract<NekRpcCommand, { type: "read_history_page" }>;
    const limit = query.turnLimit ?? 20;
    let start = Math.max(0, turns.length - limit);
    if (query.beforeCursor) start = Math.max(0, Number(query.beforeCursor) - limit);
    if (query.afterCursor) start = Number(query.afterCursor);
    if (query.aroundEntryId)
      start = Math.max(
        0,
        turns.findIndex(
          (turn) => turn.id === sources.find((source) => source.id === query.aroundEntryId)?.turnId,
        ),
      );
    const end = query.beforeCursor
      ? Math.min(turns.length, Number(query.beforeCursor))
      : Math.min(turns.length, start + limit);
    const selected = turns.slice(start, end);
    return {
      ...identity,
      ...(query.view === "summary"
        ? {
            view: "summary",
            turns: selected.map(({ header, ...turn }) => ({
              ...turn,
              headerEntryId: header.id,
              headerPosition: header.position,
              continuationCursor: `full:${turn.id}`,
            })),
          }
        : {
            turns: selected,
            entries: sources.filter((source) => selected.some((turn) => turn.id === source.turnId)),
            seed: {},
          }),
      olderCursor: start > 0 ? String(start) : undefined,
      newerCursor: end < turns.length ? String(end) : undefined,
      hasOlder: start > 0,
      hasNewer: end < turns.length,
      totalTurns: turns.length,
      totalEntries: sources.length,
    };
  }
  if (
    command.type === "read_history_subagent" &&
    (!("subagentId" in command) || command.subagentId === undefined)
  ) {
    const records = [...collectPersistedSubagentRecords(entries).values()].map(({ record }) => {
      const position = entries.findIndex(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          JSON.stringify(entry.message.details).includes(record.id),
      );
      const { id, type, description, status, sessionFile, model, startedAt, endedAt } = record;
      return {
        id,
        type,
        description,
        status,
        sessionFile,
        model,
        startedAt,
        endedAt,
        spawnEntryId: entries[position]!.id,
        spawnPosition: position,
        detached: true as const,
      };
    });
    const query = command as Extract<
      NekRpcCommand,
      { type: "read_history_subagent"; subagentId?: undefined }
    >;
    const start = Number(query.cursor ?? 0);
    const selected = records.slice(start, start + (query.limit ?? 20));
    return {
      ...identity,
      kind: "subagents",
      subagents: selected,
      total: records.length,
      count: selected.length,
      hasMore: start + selected.length < records.length,
      nextCursor:
        start + selected.length < records.length ? String(start + selected.length) : undefined,
    };
  }
  if (command.type === "read_history_subagent" && "subagentId" in command) {
    const record = collectPersistedSubagentRecords(entries).get(String(command.subagentId))?.record;
    if (!record)
      return {
        ok: false,
        error: { code: "NOT_FOUND", message: "Unknown subagent in parent session" },
      };
    const source = entries.findIndex(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        JSON.stringify(entry.message.details).includes(record.id),
    );
    return {
      ...identity,
      subagent: {
        ...record,
        detached: true,
        spawnEntryId: entries[source]!.id,
        spawnPosition: source,
      },
    };
  }
  return undefined;
}

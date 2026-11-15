import type {
  ConversationHistory,
  ConversationRow,
  StreamablePath,
} from "@zcode/shared/zcode-protocol-v4";

const utf8 = new TextEncoder();
/** Serialize only an incoming escape-bearing chunk, never a growing row or snapshot. */
export function historyAppendJsonBytes(text: string, previousTail = ""): number {
  const last = previousTail.charCodeAt(previousTail.length - 1);
  const first = text.charCodeAt(0);
  // JSON escapes two separate lone surrogates as 6+6 bytes; their combined UTF8 pair is 4.
  const correction = last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff ? 8 : 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code < 32 || code === 34 || code === 92 || (code >= 0xd800 && code <= 0xdfff))
      return utf8.encode(JSON.stringify(text)).byteLength - 2 - correction;
  }
  return utf8.encode(text).byteLength - correction;
}

/** One code unit of request-local accounting, never a second cumulative string buffer. */
export function historyStreamTail(row: ConversationRow | undefined, path: StreamablePath): string {
  if (path === "text" && (row?.kind === "assistantText" || row?.kind === "reasoning"))
    return row.text.slice(-1);
  if (path === "inputText" && row?.kind === "toolCall") return row.inputText.slice(-1);
  if (path === "output.text" && row?.kind === "toolCall") return row.output?.text.slice(-1) ?? "";
  if (path === "summaryText" && row?.kind === "subagent") return row.summaryText.slice(-1);
  return "";
}

export interface HistoryViewportAnchor {
  turnId: string;
  followingLatest: boolean;
}

/** Summary descriptors are source metadata for loaded turns, never body pages. */
export function mergeLoadedHistoryBoundary(
  history: ConversationHistory,
  rows: readonly ConversationRow[],
  boundary: ConversationHistory,
): ConversationHistory {
  const loaded = new Set(rows.map((row) => row.turnId));
  const turns = new Map(
    history.turns.filter((turn) => loaded.has(turn.turnId)).map((turn) => [turn.turnId, turn]),
  );
  for (const turn of boundary.turns) if (loaded.has(turn.turnId)) turns.set(turn.turnId, turn);
  return {
    ...history,
    ...boundary,
    turns: [...turns.values()].sort((a, b) => a.position - b.position),
    olderCursor: history.olderCursor,
    newerCursor: history.newerCursor,
    hasOlder: history.hasOlder,
    hasNewer: history.hasNewer,
  };
}

/** Navigation follows the contiguous reading segment, never jumps across an unloaded source gap. */
export function historyEdges(
  history: ConversationHistory,
  rows: readonly ConversationRow[],
  anchor?: string,
) {
  const loaded = new Set(rows.map((row) => row.turnId));
  const ordered = history.turns.filter((turn) => loaded.has(turn.turnId));
  const selected = anchor ? ordered.findIndex((turn) => turn.turnId === anchor) : -1;
  if (anchor && loaded.has(anchor) && selected < 0) return { older: undefined, newer: undefined };
  let left = selected >= 0 ? selected : ordered.length - 1;
  let right = left;
  while (left > 0 && ordered[left]!.position === ordered[left - 1]!.position + 1) left--;
  while (
    right + 1 < ordered.length &&
    ordered[right + 1]!.position === ordered[right]!.position + 1
  )
    right++;
  return { older: ordered[left], newer: ordered[right] };
}

import type { ConversationRow, StreamablePath } from "@zcode/shared/zcode-protocol-v4";

/** Exact encoded-row growth without serializing the already-rendered stream prefix on each token. */
export function streamAppendJsonBytes(
  row: ConversationRow,
  path: StreamablePath,
  append: string,
): number {
  const previous = streamText(row, path);
  if (previous === undefined)
    throw new Error("nek stream byte accounting has no matching text field");
  let bytes = Buffer.byteLength(JSON.stringify(append), "utf8") - 2;
  const last = previous.charCodeAt(previous.length - 1);
  const first = append.charCodeAt(0);
  // JSON escapes lone UTF16 surrogates (6+6 bytes), but the joined scalar is four UTF8 bytes.
  if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 8;
  return bytes;
}
function streamText(row: ConversationRow, path: StreamablePath): string | undefined {
  switch (path) {
    case "text":
      return row.kind === "assistantText" || row.kind === "reasoning" ? row.text : undefined;
    case "inputText":
      return row.kind === "toolCall" ? row.inputText : undefined;
    case "output.text":
      return row.kind === "toolCall" ? row.output?.text : undefined;
    case "summaryText":
      return row.kind === "subagent" ? row.summaryText : undefined;
  }
}

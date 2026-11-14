import type { NekHistoryEntry, NekImageContent, NekTextContent } from "@zcode/shared/nek-protocol";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildAssistantTextRow, buildReasoningRow, buildTimelineMarkerRow, buildUserInputRow, buildPlanPreviewRow, isPlanPreviewDetails, contentText, toEpochMs } from "./nekRows.js";
import { historyRowId, HISTORY_ROW_STRIDE } from "./nekHistoryIdentity.js";
import { projectNekUserImages } from "./nekUserImages.js";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const refs = (source: NekHistoryEntry) => source.omissions.map((ref) => ({ ...ref, entryId: source.id }));
function identity(source: NekHistoryEntry, entityId: string, slot: number) {
  return { entityId, rowId: historyRowId(source.position, slot), turnId: source.turnId, createdAt: toEpochMs(source.timestamp) };
}

/** Keep surviving display fields when an unrelated field is deferred. No SessionEntry cast. */
export function partialMessageRows(source: NekHistoryEntry, sessionId: string): ConversationRow[] {
  if (source.type !== "message" || !source.omissions.length || !record(source.entry)) return [];
  const message = source.entry.message;
  if (!record(message)) return [];
  const role = typeof message.role === "string" ? message.role : source.role;
  if (role === "user") return partialUser(source, sessionId, message);
  if (role !== "assistant") return [];
  const rows: ConversationRow[] = [];
  const state = message.stopReason === "aborted" ? "interrupted" : message.stopReason === "pending" ? "streaming" : "complete";
  const responseId = typeof message.timestamp === "number" ? `resp:${message.timestamp}` : `resp-entry:${source.id}`;
  if (Array.isArray(message.content)) message.content.forEach((block: unknown, index) => {
    if (block === null) return;
    if (!record(block)) throw new Error("nek invalid partial assistant display block");
    const slot = 16 + index * 4;
    if (slot + 2 >= HISTORY_ROW_STRIDE - 4) throw new Error("nek history content-block identity overflow");
    if (block.type === "text" && typeof block.text === "string") rows.push(buildAssistantTextRow(identity(source, `entry:${source.id}:text:${index}`, slot), { text: block.text, state, assistantResponseId: responseId,
      ...(typeof message.provider === "string" && typeof message.model === "string" ? { model: `${message.provider}/${message.model}` } : {}) }));
    else if (block.type === "thinking" && block.redacted !== true && typeof block.thinking === "string") rows.push(buildReasoningRow(identity(source, `entry:${source.id}:thinking:${index}`, slot + 1), { text: block.thinking, state, assistantResponseId: responseId }));
    else if (block.type !== "thinking" && block.type !== "text" && block.type !== "toolCall") throw new Error("nek unsupported partial assistant display block");
  });
  if (message.stopReason === "error") {
    if (typeof message.provider !== "string" || typeof message.model !== "string" || typeof message.api !== "string") throw new Error("nek HISTORY_DISPLAY_CONTEXT_REQUIRED: model error identity was omitted");
    const rawError = typeof message.errorMessage === "string" ? message.errorMessage : "";
    if (rawError.length > 8192) throw new Error("nek model error requires a deferred content ref");
    rows.push(buildTimelineMarkerRow(identity(source, `model-error:${source.id}`, HISTORY_ROW_STRIDE - 3), { type: "modelError", provider: message.provider, model: message.model, api: message.api, rawError }, "turnTailBoundary"));
  }
  return rows.map((row) => ({ ...row, historyContent: refs(source) }));
}
function partialUser(source: NekHistoryEntry, sessionId: string, message: Record<string, unknown>): ConversationRow[] {
  if (typeof message.content !== "string" && !Array.isArray(message.content)) return [];
  const blocks: Array<NekTextContent | NekImageContent> = [];
  if (Array.isArray(message.content)) for (const block of message.content) {
    if (block === null) { blocks.push({ type: "text", text: "" }); continue; }
    if (!record(block)) throw new Error("nek invalid partial user display block");
    if (block.type === "text" && (typeof block.text === "string" || block.text === null)) blocks.push({ type: "text", text: block.text ?? "" });
    else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    else if (block.type === "image" && (block.data === null || block.mimeType === null)) blocks.push({ type: "text", text: "" });
    else throw new Error("nek HISTORY_DISPLAY_CONTEXT_REQUIRED: user block discriminator is unavailable");
  }
  const timestamp = typeof message.timestamp === "number" ? message.timestamp : toEpochMs(source.timestamp);
  if (blocks.some((block) => block.type === "image") && typeof message.timestamp !== "number") throw new Error("nek HISTORY_DISPLAY_CONTEXT_REQUIRED: image owner timestamp is unavailable");
  const row = buildUserInputRow(identity(source, `entry:${source.id}:user`, 1), { text: typeof message.content === "string" ? message.content : contentText(blocks),
    attachments: projectNekUserImages(sessionId, { role: "user", timestamp, content: blocks }) });
  return [{ ...row, historyContent: refs(source) }];
}

export function partialCustomRows(source: NekHistoryEntry): ConversationRow[] {
  if (source.type !== "custom_message" || !source.omissions.length || !record(source.entry) || source.entry.display !== true) return [];
  if (source.entry.customType === "nek.plan_preview" && isPlanPreviewDetails(source.entry.details)) {
    const details = source.entry.details;
    return [{ ...buildPlanPreviewRow(identity(source, `entry:${source.id}:plan:${details.plan.revision}`, 2), details), historyContent: refs(source) }];
  }
  if (typeof source.entry.content !== "string" && !Array.isArray(source.entry.content)) return [];
  const text = typeof source.entry.content === "string" ? source.entry.content : contentText(source.entry.content.filter((block: unknown): block is NekTextContent => record(block) && block.type === "text" && typeof block.text === "string"));
  return text ? [{ ...buildUserInputRow(identity(source, `custom:${source.id}:${source.entry.customType}`, 2), { text, origin: "synthetic" }), historyContent: refs(source) }] : [];
}

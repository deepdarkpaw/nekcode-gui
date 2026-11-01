import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildToolCallRow,
  toolResultDisplay,
  toolResultText,
  type NekRowIdentity,
} from "./nekRows.js";

/** 结果只更新执行字段；同一工具行的输入、归属、时间与 response 身份不重新构造。 */
export function mergeToolResultRow(
  identity: NekRowIdentity,
  existing: ConversationRow | undefined,
  args: {
    toolCallId: string;
    toolName: string;
    result: unknown;
    isError: boolean;
    endedAt: number;
  },
): ToolCallRow {
  const row =
    existing?.kind === "toolCall"
      ? existing
      : buildToolCallRow(identity, {
          toolCallId: args.toolCallId,
          toolName: args.toolName,
          status: "inputStreaming",
        });
  const text = toolResultText(args.result);
  return {
    ...row,
    toolName: args.toolName,
    status: args.isError ? "error" : "success",
    output: { text, display: toolResultDisplay(args.toolName, args.result, text) },
    error: args.isError ? { code: "tool_error", message: text.slice(0, 2000) } : undefined,
    endedAt: args.endedAt,
  };
}

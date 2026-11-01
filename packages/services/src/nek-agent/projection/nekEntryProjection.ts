import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type {
  NekAgentMessage,
  NekAssistantMessage,
  NekBashExecutionMessage,
  NekCustomMessageEntry,
  NekToolResultMessage,
} from "@zcode/shared/nek-protocol";
import {
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolCalls,
  buildAssistantTextRow,
  buildPlanArtifactRow,
  buildReasoningRow,
  buildTimelineMarkerRow,
  buildToolCallRow,
  buildTurnHeaderRow,
  buildUserInputRow,
  contentText,
  isPlanPreviewDetails,
  isRedactedThinking,
  toEpochMs,
} from "./nekRows.js";
import { mergeToolResultRow } from "./nekToolResultRow.js";
import { buildConfigState, planFromNekState, summarizeUsage } from "./nekProjectionSnapshot.js";
import type { NekProjectedSnapshot, NekSnapshotInput, TurnContext } from "./nekEntryShared.js";
import { identity, orderActiveBranch, RowAllocator } from "./nekEntryShared.js";
import { projectSelectionEntry } from "./nekSelectionMarkers.js";

export type { NekProjectedSnapshot, NekSnapshotInput } from "./nekEntryShared.js";
export { orderActiveBranch } from "./nekEntryShared.js";

/**
 * entries → 行的投影（快照路径）。
 *
 * 为什么以 entries 为主：entries 同时携带对话消息、压缩/分支摘要、模型与思考等级变更、
 * 自定义状态，是唯一能完整还原时间线的来源；`messages` 只在 entries 缺失时兜底。
 */

export function projectEntries(input: NekSnapshotInput): NekProjectedSnapshot {
  const allocator = new RowAllocator(input.existing);
  const branch = orderActiveBranch(input.entries, input.leafId);
  const rows: ConversationRow[] = [];
  const toolRows = new Map<string, number>();

  let turn: TurnContext = { turnId: "turn-0", entityId: "turn-0", startedAt: 0 };
  let turnOpen = false;
  let title = input.title ?? "";
  let mode = input.nekState?.mode ?? "agent";
  let provider = input.state?.model?.provider ?? "";
  let model = input.state?.model?.id ?? "";
  let thought: string = input.state?.thinkingLevel ?? "";
  let selectionCursor: Parameters<typeof projectSelectionEntry>[0] = {};

  // 同一 entityId 可能被先后投影两次（例如 toolCall 内容块与对应的 toolResult）：
  // 后者是同一行的状态更新，必须替换而不是再追加一行。
  const push = (row: ConversationRow) => {
    const index = rows.findIndex((existing) => existing.rowId === row.rowId);
    if (index === -1) rows.push(row);
    else rows[index] = row;
    return row;
  };
  const pushTurnHeader = (
    state: "running" | "completedSuccess" | "completedInterrupted" | "failed",
  ) => {
    const rowId = allocator.resolve(turn.entityId);
    return push(
      buildTurnHeaderRow(identity(turn.entityId, rowId, turn.turnId, turn.startedAt), {
        state,
        ...(state === "running" ? {} : { endedAt: turn.startedAt }),
      }),
    );
  };
  const startTurn = (message: NekAgentMessage) => {
    if (turnOpen) pushTurnHeader("completedSuccess");
    const timestamp = toEpochMs(message.timestamp as number | undefined);
    const entityId = `turn:${timestamp}:${turn.turnId}`;
    turn = { turnId: entityId, entityId, startedAt: timestamp };
    turnOpen = true;
    pushTurnHeader("running");
  };

  for (const entry of branch) {
    switch (entry.type) {
      case "session_info": {
        if (typeof entry.name === "string" && entry.name !== "") title = entry.name;
        break;
      }
      case "model_change":
      case "thinking_level_change": {
        const { next, marker } = projectSelectionEntry(selectionCursor, entry);
        selectionCursor = next;
        if (entry.type === "model_change") {
          provider = entry.provider;
          model = entry.modelId;
        } else {
          thought = entry.thinkingLevel;
        }
        if (marker) {
          const rowId = allocator.resolve(`entry:${entry.id}`);
          push(
            buildTimelineMarkerRow(
              identity(`entry:${entry.id}`, rowId, turn.turnId, toEpochMs(entry.timestamp)),
              marker,
              "lightBoundary",
            ),
          );
        }
        break;
      }
      case "compaction": {
        const rowId = allocator.resolve(`entry:${entry.id}`);
        push(
          buildTimelineMarkerRow(
            identity(`entry:${entry.id}`, rowId, turn.turnId, toEpochMs(entry.timestamp)),
            {
              type: "compact",
              origin: entry.fromHook === true ? "manual" : "auto",
              status: "success",
              tokensBefore: entry.tokensBefore,
              summaryRef: entry.id,
            },
            "assistantWork",
          ),
        );
        break;
      }
      case "branch_summary": {
        const rowId = allocator.resolve(`entry:${entry.id}`);
        push(
          buildTimelineMarkerRow(
            identity(`entry:${entry.id}`, rowId, turn.turnId, toEpochMs(entry.timestamp)),
            {
              type: "compact",
              origin: "manual",
              status: "success",
              summaryRef: entry.id,
            },
            "assistantWork",
          ),
        );
        break;
      }
      case "custom_message": {
        // `display: false` 的隐藏消息（如 `@skill:` 展开出的 `skill_mention`）不进对话记录。
        if (entry.display === false) break;
        const row = projectCustomMessage(entry as NekCustomMessageEntry, turn, allocator);
        if (row) push(row);
        break;
      }
      case "message": {
        const message = entry.message;
        if (message.role === "user") {
          startTurn(message);
          const rowId = allocator.resolve(`entry:${entry.id}:user`);
          push(
            buildUserInputRow(
              identity(`entry:${entry.id}:user`, rowId, turn.turnId, toEpochMs(entry.timestamp)),
              {
                text: contentText(message.content as string | Array<{ type: string }>),
              },
            ),
          );
          break;
        }
        if (message.role === "assistant") {
          if (!turnOpen) startTurn(message);
          const assistant = message as NekAssistantMessage;
          const responseId = `resp:${assistant.timestamp}`;
          for (const block of assistantThinkingBlocks(assistant)) {
            if (
              isRedactedThinking({
                type: "thinking",
                thinking: block.text,
                redacted: block.redacted,
              })
            )
              continue;
            const entityId = `entry:${entry.id}:thinking:${block.index}`;
            const rowId = allocator.resolve(entityId);
            push(
              buildReasoningRow(
                identity(entityId, rowId, turn.turnId, toEpochMs(entry.timestamp)),
                {
                  text: block.text,
                  state: "complete",
                  assistantResponseId: responseId,
                },
              ),
            );
          }
          for (const block of assistantTextBlocks(assistant)) {
            const entityId = `entry:${entry.id}:text:${block.index}`;
            const rowId = allocator.resolve(entityId);
            push(
              buildAssistantTextRow(
                identity(entityId, rowId, turn.turnId, toEpochMs(entry.timestamp)),
                {
                  text: block.text,
                  state: "complete",
                  model: `${assistant.provider}/${assistant.model}`,
                  assistantResponseId: responseId,
                },
              ),
            );
          }
          for (const call of assistantToolCalls(assistant)) {
            const entityId = `tool:${call.toolCall.id}`;
            const rowId = allocator.resolve(entityId);
            toolRows.set(call.toolCall.id, rowId);
            push(
              buildToolCallRow(identity(entityId, rowId, turn.turnId, toEpochMs(entry.timestamp)), {
                toolCallId: call.toolCall.id,
                toolName: call.toolCall.name,
                status: "inputStreaming",
                inputText: JSON.stringify(call.toolCall.arguments ?? {}, null, 2),
                input: call.toolCall.arguments,
                assistantResponseId: responseId,
              }),
            );
          }
          break;
        }
        if (message.role === "toolResult") {
          const result = message as NekToolResultMessage;
          const rowId =
            toolRows.get(result.toolCallId) ?? allocator.resolve(`tool:${result.toolCallId}`);
          toolRows.set(result.toolCallId, rowId);
          push(
            mergeToolResultRow(
              identity(`tool:${result.toolCallId}`, rowId, turn.turnId, toEpochMs(entry.timestamp)),
              rows.find((row) => row.rowId === rowId),
              {
                toolCallId: result.toolCallId,
                toolName: result.toolName,
                result,
                isError: result.isError,
                endedAt: toEpochMs(entry.timestamp),
              },
            ),
          );
          break;
        }
        if (message.role === "bashExecution") {
          const bash = message as NekBashExecutionMessage;
          const entityId = `bash:${bash.timestamp}`;
          const rowId = allocator.resolve(entityId);
          const failed = bash.exitCode !== undefined && bash.exitCode !== 0;
          push(
            buildToolCallRow(identity(entityId, rowId, turn.turnId, toEpochMs(entry.timestamp)), {
              toolCallId: entityId,
              toolName: "bash",
              status: failed ? "error" : "success",
              inputText: bash.command,
              input: { command: bash.command },
              output: {
                text: bash.output,
                display: {
                  kind: "bash_output",
                  output: bash.output.slice(0, 150_000),
                  truncated: bash.truncated,
                  ...(bash.fullOutputPath ? { outputPath: bash.fullOutputPath } : {}),
                },
              },
              ...(failed
                ? { error: { code: "exit_code", message: `exit ${bash.exitCode ?? "unknown"}` } }
                : {}),
              endedAt: toEpochMs(entry.timestamp),
            }),
          );
          break;
        }
        if (message.role === "branchSummary") {
          const rowId = allocator.resolve(`entry:${entry.id}:branchSummary`);
          push(
            buildTimelineMarkerRow(
              identity(
                `entry:${entry.id}:branchSummary`,
                rowId,
                turn.turnId,
                toEpochMs(entry.timestamp),
              ),
              { type: "compact", origin: "manual", status: "success", summaryRef: entry.id },
              "assistantWork",
            ),
          );
          break;
        }
        if (message.role === "compactionSummary") {
          const rowId = allocator.resolve(`entry:${entry.id}:compactionSummary`);
          push(
            buildTimelineMarkerRow(
              identity(
                `entry:${entry.id}:compactionSummary`,
                rowId,
                turn.turnId,
                toEpochMs(entry.timestamp),
              ),
              {
                type: "compact",
                origin: "auto",
                status: "success",
                tokensBefore: message.tokensBefore,
                summaryRef: entry.id,
              },
              "assistantWork",
            ),
          );
          break;
        }
        break;
      }
      default:
        // label / custom / usage / context_edit 不产生对话行：
        // usage 计入统计，context_edit 只影响模型上下文，label 没有 v4 对应物。
        break;
    }
  }
  if (turnOpen) pushTurnHeader("completedSuccess");

  const usage = summarizeUsage(branch, {
    contextWindow: input.stats?.contextUsage?.contextWindow ?? input.state?.model?.contextWindow,
    ...(input.stats?.contextUsage?.tokens == null
      ? {}
      : { usedTokens: input.stats.contextUsage.tokens }),
  });
  const plan = planFromNekState(input.nekState);
  if (input.nekState) mode = input.nekState.mode;
  return {
    rows,
    byEntity: allocator.entityMap,
    nextRowId: allocator.nextId,
    title,
    config: buildConfigState(input.state, provider, model, thought, mode),
    usage,
    plan,
    mode,
  };
}

function projectCustomMessage(
  entry: NekCustomMessageEntry,
  turn: TurnContext,
  allocator: RowAllocator,
): ConversationRow | null {
  if (entry.customType === "nek.plan_preview" && isPlanPreviewDetails(entry.details)) {
    const entityId = `entry:${entry.timestamp}:plan:${entry.details.plan.revision}`;
    const rowId = allocator.resolve(entityId);
    return buildPlanArtifactRow(
      identity(entityId, rowId, turn.turnId, toEpochMs(entry.timestamp)),
      entry.details,
    );
  }
  // 其他 custom 消息等价于"注入的用户侧上下文"：用 synthetic 来源的 userInput 呈现。
  const text = contentText(entry.content as string | Array<{ type: string }>);
  if (text.trim() === "") return null;
  const entityId = `custom:${entry.timestamp}:${entry.customType}`;
  const rowId = allocator.resolve(entityId);
  return buildUserInputRow(identity(entityId, rowId, turn.turnId, toEpochMs(entry.timestamp)), {
    text,
    origin: "synthetic",
  });
}

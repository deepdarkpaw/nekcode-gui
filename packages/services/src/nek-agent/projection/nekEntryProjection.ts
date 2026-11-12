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
  buildModelErrorMarker,
  buildReasoningRow,
  buildTimelineMarkerRow,
  buildToolCallRow,
  buildTurnHeaderRow,
  buildUserInputRow,
  contentText,
  isRedactedThinking,
  toEpochMs,
} from "./nekRows.js";
import { mergeToolResultRow } from "./nekToolResultRow.js";
import { settleInactiveNekWorkRows } from "./nekSettledWork.js";
import { buildConfigState, planFromNekState, summarizeUsage } from "./nekProjectionSnapshot.js";
import type { NekProjectedSnapshot, NekSnapshotInput, TurnContext } from "./nekEntryShared.js";
import {
  identity,
  orderActiveBranch,
  projectCustomMessage,
  RowAllocator,
} from "./nekEntryShared.js";
import { planSubagentRows, type SubagentRowAnchor } from "./nekSubagentRecords.js";
import { projectSelectionEntry } from "./nekSelectionMarkers.js";
import { projectNekUserImages } from "./nekUserImages.js";
import { projectNekUserFiles, readNekStoredAttachments, withNekUserFiles } from "./nekUserFiles.js";

export type { NekProjectedSnapshot, NekSnapshotInput } from "./nekEntryShared.js";
export { orderActiveBranch } from "./nekEntryShared.js";

/** entries → 行的输入；`isSessionRunning` 只在冷恢复时需要显式给出。 */
interface NekProjectionInput extends NekSnapshotInput {
  /**
   * 父会话此刻是否仍在流式运行。缺省按 `state.isStreaming` 判定（拿不到 state 即 false）：
   * 磁盘里残留的 `"running"` 子代理记录不能在没有活进程时继续显示为运行中。
   */
  isSessionRunning?: boolean;
}

/**
 * entries → 行的投影（快照路径）。
 *
 * 为什么以 entries 为主：entries 同时携带对话消息、压缩/分支摘要、模型与思考等级变更、
 * 自定义状态，是唯一能完整还原时间线的来源；`messages` 只在 entries 缺失时兜底。
 */

export function projectEntries(input: NekProjectionInput): NekProjectedSnapshot {
  const allocator = new RowAllocator(input.existing);
  const branch = orderActiveBranch(input.entries, input.leafId);
  const rows: ConversationRow[] = [];
  const rowIndexById = new Map<number, number>();
  const toolRows = new Map<string, number>();
  // 子代理行身份 = `subagent:<record.id>`；锚点只在首次出现时确定。
  let subagentAnchors: ReadonlyMap<string, SubagentRowAnchor> = new Map();
  const sessionRunning = input.isSessionRunning ?? input.state?.isStreaming === true;
  const liveSubagents = input.nekState
    ? new Map(input.nekState.subagents.map((record) => [record.id, record]))
    : undefined;

  let turn: TurnContext = { turnId: "turn-0", entityId: "turn-0", startedAt: 0 };
  let turnOpen = false;
  let lastActivityAt: number | undefined;
  let lastStopReason: string | undefined;
  const completedState = () =>
    lastStopReason === "aborted"
      ? "completedInterrupted"
      : lastStopReason === "error"
        ? "failed"
        : "completedSuccess";
  let title = input.title ?? "";
  let mode = input.nekState?.mode ?? "agent";
  let provider = input.state?.model?.provider ?? "";
  let model = input.state?.model?.id ?? "";
  let thought: string = input.state?.thinkingLevel ?? "";
  let selectionCursor: Parameters<typeof projectSelectionEntry>[0] = {};

  // 同一 entityId 可能被先后投影两次（例如 toolCall 内容块与对应的 toolResult）：
  // 后者是同一行的状态更新，必须替换而不是再追加一行。
  const push = (row: ConversationRow) => {
    const index = rowIndexById.get(row.rowId);
    if (index === undefined) {
      rowIndexById.set(row.rowId, rows.length);
      rows.push(row);
    } else rows[index] = row;
    return row;
  };
  const pushTurnHeader = (
    state: "running" | "completedSuccess" | "completedInterrupted" | "failed",
  ) => {
    const rowId = allocator.resolve(turn.entityId);
    return push(
      buildTurnHeaderRow(identity(turn.entityId, rowId, turn.turnId, turn.startedAt), {
        state,
        ...(state === "running" ? {} : { endedAt: lastActivityAt }),
      }),
    );
  };
  const startTurn = (message: NekAgentMessage) => {
    if (turnOpen) pushTurnHeader(completedState());
    lastActivityAt = undefined;
    lastStopReason = undefined;
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
        const files = readNekStoredAttachments(entry);
        if (files) {
          // CLI 将附件消息紧接在所属 user 后落盘；按 parentId 配对，不靠文本/时间/并发顺序猜。
          const parentRowId = allocator.resolve(`entry:${entry.parentId}:user`);
          const parentIndex = rowIndexById.get(parentRowId);
          const parent = parentIndex === undefined ? undefined : rows[parentIndex];
          if (parent?.kind !== "userInput")
            throw new Error("nek attachments have no owning user entry");
          push(withNekUserFiles(parent, projectNekUserFiles(input.sessionId, files)));
          break;
        }
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
                text: contentText(message.content),
                attachments: projectNekUserImages(input.sessionId, message),
              },
            ),
          );
          break;
        }
        if (message.role === "assistant") {
          if (!turnOpen) startTurn(message);
          const assistant = message as NekAssistantMessage;
          lastStopReason = assistant.stopReason;
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
          const modelError = buildModelErrorMarker(assistant);
          if (modelError) {
            const entityId = `model-error:${assistant.timestamp}`;
            const rowId = allocator.resolve(entityId);
            const previous = rows[rowIndexById.get(rowId) ?? -1];
            const owner = previous?.turnId ?? turn.turnId;
            const at = previous?.createdAt ?? toEpochMs(assistant.timestamp);
            push(
              buildTimelineMarkerRow(
                identity(entityId, rowId, owner, at),
                modelError,
                "turnTailBoundary",
              ),
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
              rows[rowIndexById.get(rowId) ?? -1],
              {
                toolCallId: result.toolCallId,
                toolName: result.toolName,
                result,
                isError: result.isError,
                endedAt: toEpochMs(entry.timestamp),
              },
            ),
          );
          // 子代理 details 是重开 GUI 后唯一还在的事实（registry 是纯内存表）：
          // 首次出现建行，后续 `await` / `stop_subagent` 原地更新同一行。
          const subagents = planSubagentRows(
            subagentAnchors,
            result,
            turn.turnId,
            sessionRunning,
            (entityId) => allocator.resolve(entityId),
            liveSubagents,
          );
          subagentAnchors = subagents.anchors;
          for (const row of subagents.rows) push(row);
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
    // Durable history can copy the request-start timestamp into the persisted assistant entry.
    // That is not a completion time. Never report that interval as the entire turn's duration.
    if (turnOpen && entry.type === "message" && entry.message.role !== "user") {
      const timestamp = toEpochMs(entry.timestamp);
      if (entry.message.role === "assistant" && timestamp <= entry.message.timestamp) {
        lastActivityAt = undefined;
      } else if (timestamp >= turn.startedAt) {
        lastActivityAt = Math.max(lastActivityAt ?? 0, timestamp);
      }
    }
  }
  if (turnOpen) {
    pushTurnHeader(input.state?.isStreaming === true ? "running" : completedState());
  }
  settleInactiveNekWorkRows(rows);

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

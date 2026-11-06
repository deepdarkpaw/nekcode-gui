import type {
  NekAgentMessage,
  NekAssistantMessage,
  NekBashExecutionMessage,
  NekCustomMessage,
  NekRpcEvent,
  NekToolResultMessage,
} from "@zcode/shared/nek-protocol";
import {
  assistantTextBlocks,
  assistantThinkingBlocks,
  assistantToolCalls,
  buildAssistantTextRow,
  buildPlanPreviewRow,
  buildReasoningRow,
  buildToolCallRow,
  buildUserInputRow,
  contentText,
  isPlanPreviewDetails,
  isRedactedThinking,
  toEpochMs,
} from "./nekRows.js";
import { mergeToolResultRow } from "./nekToolResultRow.js";
import { currentTurnId, ensureTurn, rowIdentity } from "./nekLiveTurn.js";
import type { NekLiveContext } from "./nekLiveTurn.js";
import { applySubagentDetails } from "./nekLiveTools.js";
import { projectNekUserImages } from "./nekUserImages.js";
import { appendToolArgument } from "./nekToolInput.js";

/**
 * 消息生命周期 → 行。
 *
 * `message_update` 在线上只有增量（没有累积快照），因此按 `contentIndex` 自己累积，
 * 并在 `text_end` / `thinking_end` / `message_end` 时用权威内容覆盖。
 */

export function applyMessageStart(ctx: NekLiveContext, message: NekAgentMessage | undefined): void {
  if (!message) return;
  if (message.role === "assistant") {
    const assistant = message as NekAssistantMessage;
    ctx.assistantResponseKey = `resp:${assistant.timestamp}`;
    ctx.assistantModel = `${assistant.provider}/${assistant.model}`;
    ensureTurn(ctx, toEpochMs(assistant.timestamp));
    return;
  }
  if (message.role === "user") {
    const timestamp = toEpochMs(message.timestamp);
    ensureTurn(ctx, timestamp);
    const entityId = `msg:${timestamp}:user`;
    const rowId = ctx.store.allocate(entityId);
    ctx.store.add(
      buildUserInputRow(rowIdentity(entityId, rowId, currentTurnId(ctx), timestamp), {
        text: contentText(message.content),
        attachments: projectNekUserImages(ctx.store.sessionId, message),
      }),
    );
    return;
  }
  if (message.role === "custom") {
    applyCustomMessage(ctx, message as NekCustomMessage);
    return;
  }
  if (message.role === "bashExecution") {
    applyBashExecutionMessage(ctx, message as NekBashExecutionMessage);
  }
}

export function applyMessageUpdate(
  ctx: NekLiveContext,
  event: Extract<NekRpcEvent, { type: "message_update" }>,
): void {
  const update = event.assistantMessageEvent;
  const responseKey = ctx.assistantResponseKey ?? `resp:unknown:${ctx.markerSerial}`;
  const createdAt = ctx.now();

  const textRow = (role: "text" | "thinking", contentIndex: number): number => {
    const entityId = `${responseKey}:${role}:${contentIndex}`;
    const known = ctx.streamRows.get(entityId);
    if (known !== undefined) return known;
    const rowId = ctx.store.allocate(entityId);
    ctx.streamRows.set(entityId, rowId);
    const identity = rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt);
    ctx.store.add(
      role === "text"
        ? buildAssistantTextRow(identity, {
            text: "",
            state: "streaming",
            ...(ctx.assistantModel ? { model: ctx.assistantModel } : {}),
            assistantResponseId: responseKey,
          })
        : buildReasoningRow(identity, {
            text: "",
            state: "streaming",
            assistantResponseId: responseKey,
          }),
    );
    return rowId;
  };

  switch (update.type) {
    case "start":
      if (update.message) applyAssistantMessage(ctx, update.message, true);
      return;
    case "text_delta":
      ctx.store.appendStream(textRow("text", update.contentIndex), "text", update.delta);
      return;
    case "text_end": {
      const rowId = textRow("text", update.contentIndex);
      ctx.store.update(rowId, (row) =>
        row.kind === "assistantText" ? { ...row, text: update.content } : row,
      );
      return;
    }
    case "thinking_delta":
      ctx.store.appendStream(textRow("thinking", update.contentIndex), "text", update.delta);
      return;
    case "thinking_end": {
      const rowId = textRow("thinking", update.contentIndex);
      ctx.store.update(rowId, (row) =>
        row.kind === "reasoning" ? { ...row, text: update.content } : row,
      );
      return;
    }
    case "toolcall_start": {
      // 工具行身份直接用 toolCallId：toolcall_start/delta/end、tool_execution_* 与 toolResult
      // 都带着它，所以同一个工具调用只会有一行。
      const entityId = `tool:${update.id}`;
      const rowId = ctx.store.allocate(entityId);
      ctx.streamRows.set(`${responseKey}:tool:${update.contentIndex}`, rowId);
      ctx.toolRows.set(update.id, rowId);
      ctx.store.add(
        buildToolCallRow(rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt), {
          toolCallId: update.id,
          toolName: update.toolName,
          status: "inputStreaming",
          inputText: "",
          assistantResponseId: responseKey,
        }),
      );
      return;
    }
    case "toolcall_delta": {
      const known = ctx.streamRows.get(`${responseKey}:tool:${update.contentIndex}`);
      if (known === undefined) return;
      if (update.arguments !== undefined || update.argumentPath !== undefined) {
        ctx.store.update(known, (row) =>
          row.kind === "toolCall"
            ? {
                ...row,
                input:
                  update.arguments !== undefined
                    ? update.arguments
                    : appendToolArgument(row.input, update.argumentPath!, update.delta),
                // 参数字段已结构化累积；不要再保留一份错误/重复的 JSON 拼接缓冲。
                inputText: "",
              }
            : row,
        );
      } else {
        ctx.store.appendStream(known, "inputText", update.delta);
      }
      return;
    }
    case "toolcall_end": {
      const call = update.toolCall;
      const rowId = ctx.store.allocate(`tool:${call.id}`);
      ctx.streamRows.set(`${responseKey}:tool:${update.contentIndex}`, rowId);
      ctx.toolRows.set(call.id, rowId);
      // 权威内容覆盖流式累积的 inputText：解析后的 arguments 才是事实。
      ctx.store.add(
        buildToolCallRow(rowIdentity(`tool:${call.id}`, rowId, currentTurnId(ctx), createdAt), {
          toolCallId: call.id,
          toolName: call.name,
          status: "inputStreaming",
          inputText: JSON.stringify(call.arguments ?? {}, null, 2),
          input: call.arguments,
          assistantResponseId: responseKey,
        }),
      );
      return;
    }
    default:
      // `start` / `done` / `error` 不产生行：完成态由 message_end 决定。
      return;
  }
}

export function applyMessageEnd(ctx: NekLiveContext, message: NekAgentMessage | undefined): void {
  if (!message) return;
  if (message.role === "assistant") {
    applyAssistantMessage(ctx, message as NekAssistantMessage, false);
    return;
  }
  if (message.role === "toolResult") {
    applyToolResultMessage(ctx, message as NekToolResultMessage);
    return;
  }
  if (message.role === "custom") {
    applyCustomMessage(ctx, message as NekCustomMessage);
    return;
  }
  if (message.role === "bashExecution") {
    applyBashExecutionMessage(ctx, message as NekBashExecutionMessage);
  }
}

function applyAssistantMessage(
  ctx: NekLiveContext,
  assistant: NekAssistantMessage,
  streaming: boolean,
): void {
  const responseKey = ctx.assistantResponseKey ?? `resp:${assistant.timestamp}`;
  const createdAt = toEpochMs(assistant.timestamp);
  const model = `${assistant.provider}/${assistant.model}`;
  if (ctx.turn) ctx.turn.lastStopReason = assistant.stopReason;
  const textState = streaming
    ? "streaming"
    : assistant.stopReason === "aborted"
      ? "interrupted"
      : "complete";

  for (const block of assistantThinkingBlocks(assistant)) {
    if (isRedactedThinking({ type: "thinking", thinking: block.text, redacted: block.redacted }))
      continue;
    const entityId = `${responseKey}:thinking:${block.index}`;
    const rowId = ctx.store.allocate(entityId);
    ctx.streamRows.set(entityId, rowId);
    ctx.store.add(
      buildReasoningRow(rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt), {
        text: block.text,
        state: textState,
        assistantResponseId: responseKey,
      }),
    );
  }
  for (const block of assistantTextBlocks(assistant)) {
    const entityId = `${responseKey}:text:${block.index}`;
    const rowId = ctx.store.allocate(entityId);
    ctx.streamRows.set(entityId, rowId);
    ctx.store.add(
      buildAssistantTextRow(rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt), {
        text: block.text,
        state: textState,
        model,
        assistantResponseId: responseKey,
      }),
    );
  }
  for (const call of assistantToolCalls(assistant)) {
    const entityId = `tool:${call.toolCall.id}`;
    const rowId = ctx.store.allocate(entityId);
    ctx.toolRows.set(call.toolCall.id, rowId);
    ctx.streamRows.set(`${responseKey}:tool:${call.index}`, rowId);
    const existing = ctx.store.getRow(rowId);
    ctx.store.add(
      buildToolCallRow(rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt), {
        toolCallId: call.toolCall.id,
        toolName: call.toolCall.name,
        status: "inputStreaming",
        inputText: JSON.stringify(call.toolCall.arguments ?? {}, null, 2),
        input: call.toolCall.arguments,
        assistantResponseId: responseKey,
        ...(existing?.kind === "toolCall" && existing.output ? { output: existing.output } : {}),
        ...(existing?.kind === "toolCall" && existing.error ? { error: existing.error } : {}),
      }),
    );
  }
  // 该 response 的流式累积到此为止：丢弃 key，下一次 message_start 重新建立。
  ctx.assistantResponseKey = streaming ? responseKey : undefined;
}

function applyToolResultMessage(ctx: NekLiveContext, result: NekToolResultMessage): void {
  const entityId = `tool:${result.toolCallId}`;
  const rowId = ctx.store.allocate(entityId);
  ctx.toolRows.set(result.toolCallId, rowId);
  if (result.details !== undefined) ctx.toolDetails.set(result.toolCallId, result.details);
  ctx.store.add(
    mergeToolResultRow(
      rowIdentity(entityId, rowId, currentTurnId(ctx), toEpochMs(result.timestamp)),
      ctx.store.getRow(rowId),
      {
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        result,
        isError: result.isError,
        endedAt: toEpochMs(result.timestamp),
      },
    ),
  );
  if (result.toolName === "subagent") applySubagentDetails(ctx, result.toolCallId, result.details);
}

/**
 * `custom` 消息 → 行。
 *
 * `display: false` 表示"只给模型看、不进对话记录"：`@skill:name` 展开的
 * `customType: "skill_mention"` 隐藏消息就是这一类（nek 把它紧跟在用户消息后面发给模型）。
 * 它们不生成任何可见行，用户输入原样显示，`@agent:`/`@skill:` 的高亮由渲染层负责。
 */
function applyCustomMessage(ctx: NekLiveContext, message: NekCustomMessage): void {
  if (message.display === false) return;
  const timestamp = toEpochMs(message.timestamp);
  if (message.customType === "nek.plan_preview" && isPlanPreviewDetails(message.details)) {
    const entityId = `plan:${message.details.plan.path}#r${message.details.plan.revision}`;
    const rowId = ctx.store.allocate(entityId);
    ctx.store.add(
      buildPlanPreviewRow(
        rowIdentity(entityId, rowId, currentTurnId(ctx), timestamp),
        message.details,
      ),
    );
    return;
  }
  const text = contentText(message.content as string | Array<{ type: string }>);
  if (text.trim() === "") return;
  const entityId = `msg:${timestamp}:custom:${message.customType}`;
  const rowId = ctx.store.allocate(entityId);
  ctx.store.add(
    buildUserInputRow(rowIdentity(entityId, rowId, currentTurnId(ctx), timestamp), {
      text,
      origin: "synthetic",
    }),
  );
}

function applyBashExecutionMessage(ctx: NekLiveContext, bash: NekBashExecutionMessage): void {
  const timestamp = toEpochMs(bash.timestamp);
  const entityId = `bash:${timestamp}`;
  const rowId = ctx.store.allocate(entityId);
  const failed = bash.exitCode !== undefined && bash.exitCode !== 0;
  ctx.store.add(
    buildToolCallRow(rowIdentity(entityId, rowId, currentTurnId(ctx), timestamp), {
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
      endedAt: timestamp,
    }),
  );
}

export { applyCustomMessage };

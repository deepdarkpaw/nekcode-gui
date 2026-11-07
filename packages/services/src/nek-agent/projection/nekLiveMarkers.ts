import type {
  NekBashResult,
  NekCompactionResult,
  NekExtensionEvent,
  NekRpcEvent,
  NekRpcSessionState,
  NekSessionEntry,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { buildTimelineMarkerRow, buildToolCallRow, toEpochMs } from "./nekRows.js";
import { currentTurnId, rowIdentity } from "./nekLiveTurn.js";
import type { NekLiveContext } from "./nekLiveTurn.js";
import { applySubagentRecord } from "./nekLiveTools.js";
import { applyCustomMessage } from "./nekLiveMessages.js";
import { projectSelectionEntry } from "./nekSelectionMarkers.js";
import { withNekModelSelection, withNekMode } from "./nekProjectionSnapshot.js";

/**
 * 时间线标记、扩展追加的条目、直接 bash 的结果与扩展状态。
 *
 * v4 的 timelineMarker 载荷是封闭联合（compact / forkNotice / forkCreated / modelChange /
 * goalSet / goalVerify / retryNotice / checkpointRestored），nek 的语义要往这 8 种里落：
 * - 压缩 → compact；分支摘要也用 compact（两者都是"上下文被摘要"），见报告里的映射说明；
 * - 自动重试 → retryNotice；
 * - 模型/思考等级切换 → modelChange（思考等级单独变化时 from/to 模型相同）。
 */

function nextMarkerEntity(ctx: NekLiveContext, kind: string): string {
  ctx.markerSerial += 1;
  return `marker:${kind}:${ctx.markerSerial}`;
}

export function applyCompactionStart(
  ctx: NekLiveContext,
  reason: "manual" | "threshold" | "overflow",
): void {
  const entityId = nextMarkerEntity(ctx, "compact");
  const rowId = ctx.store.allocate(entityId);
  ctx.store.add(
    buildTimelineMarkerRow(
      rowIdentity(entityId, rowId, currentTurnId(ctx), ctx.now()),
      { type: "compact", origin: reason === "manual" ? "manual" : "auto", status: "running" },
      "assistantWork",
    ),
  );
  ctx.store.setState({
    control: {
      ...ctx.store.state.control,
      stopTargetKind: "compact",
      canStop: true,
    },
  });
}

export function applyCompactionEnd(
  ctx: NekLiveContext,
  event: Extract<NekRpcEvent, { type: "compaction_end" }>,
): void {
  const result = event.result as NekCompactionResult | undefined;
  const status: "success" | "cancelled" | "failed" | "noop" = event.aborted
    ? "cancelled"
    : event.errorMessage
      ? "failed"
      : result
        ? "success"
        : "noop";
  const entityId = nextMarkerEntity(ctx, "compactEnd");
  const rowId = ctx.store.allocate(entityId);
  ctx.store.add(
    buildTimelineMarkerRow(
      rowIdentity(entityId, rowId, currentTurnId(ctx), ctx.now()),
      {
        type: "compact",
        origin: event.reason === "manual" ? "manual" : "auto",
        status,
        ...(result ? { tokensBefore: result.tokensBefore } : {}),
        ...(result?.estimatedTokensAfter === undefined
          ? {}
          : { tokensAfter: result.estimatedTokensAfter }),
      },
      "assistantWork",
    ),
  );
  ctx.store.setState({ control: { ...ctx.store.state.control, stopTargetKind: "unknown" } });
}

export function applyRetryMarker(ctx: NekLiveContext, attempt: number): void {
  const entityId = nextMarkerEntity(ctx, "retry");
  const rowId = ctx.store.allocate(entityId);
  ctx.store.add(
    buildTimelineMarkerRow(rowIdentity(entityId, rowId, currentTurnId(ctx), ctx.now()), {
      type: "retryNotice",
      attempt,
      reasonCode: "auto_retry",
    }),
  );
}

/** `entry_appended`：扩展追加的持久条目（模型变化、压缩、分支摘要、自定义消息、会话名）。 */
export function applyAppendedEntry(ctx: NekLiveContext, entry: NekSessionEntry | undefined): void {
  if (!entry) return;
  const createdAt = toEpochMs(entry.timestamp);
  switch (entry.type) {
    case "model_change":
    case "thinking_level_change": {
      const config = ctx.store.state.config;
      const { marker } = projectSelectionEntry(config, entry);
      if (marker) {
        const entityId = `entry:${entry.id}`;
        const rowId = ctx.store.allocate(entityId);
        ctx.store.add(
          buildTimelineMarkerRow(
            rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt),
            marker,
            "lightBoundary",
          ),
        );
      }
      ctx.store.setState({
        config: withNekModelSelection(
          entry.type === "model_change"
            ? { ...config, provider: entry.provider, model: entry.modelId }
            : { ...config, thought: entry.thinkingLevel },
        ),
      });
      return;
    }
    case "compaction": {
      const entityId = `entry:${entry.id}`;
      const rowId = ctx.store.allocate(entityId);
      ctx.store.add(
        buildTimelineMarkerRow(
          rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt),
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
      return;
    }
    case "branch_summary": {
      const entityId = `entry:${entry.id}`;
      const rowId = ctx.store.allocate(entityId);
      ctx.store.add(
        buildTimelineMarkerRow(
          rowIdentity(entityId, rowId, currentTurnId(ctx), createdAt),
          { type: "compact", origin: "manual", status: "success", summaryRef: entry.id },
          "assistantWork",
        ),
      );
      return;
    }
    case "custom_message": {
      // 扩展追加的隐藏消息（`display: false`）同样不投影成可见行。
      if (entry.display === false) return;
      applyCustomMessage(ctx, {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: createdAt,
      });
      return;
    }
    case "session_info": {
      if (typeof entry.name === "string") ctx.store.setState({ title: entry.name });
      return;
    }
    default:
      // usage / context_edit / label / custom / message：不产生行（见报告映射表）。
      return;
  }
}

/** 直接 `bash` 命令的流式输出。 */
export function applyBashExecutionUpdate(
  ctx: NekLiveContext,
  requestId: string | undefined,
  delta: string,
): void {
  const key = requestId ?? "anonymous";
  const entityId = `bash:req:${key}`;
  const rowId = ctx.store.allocate(entityId);
  if (!ctx.store.getRow(rowId)) {
    ctx.store.add(
      buildToolCallRow(rowIdentity(entityId, rowId, currentTurnId(ctx), ctx.now()), {
        toolCallId: entityId,
        toolName: "bash",
        status: "running",
        inputText: "",
        output: { text: "" },
        startedAt: ctx.now(),
      }),
    );
  }
  ctx.store.appendStream(rowId, "output.text", delta);
}

/** 直接 `bash` 命令的最终结果。 */
export function applyBashCommandResultRow(
  ctx: NekLiveContext,
  requestId: string,
  command: string,
  result: NekBashResult,
): void {
  const entityId = `bash:req:${requestId}`;
  const rowId = ctx.store.allocate(entityId);
  const existing = ctx.store.getRow<ToolCallRow>(rowId);
  const failed = result.exitCode !== undefined && result.exitCode !== 0;
  const endedAt = ctx.now();
  ctx.store.add(
    buildToolCallRow(
      rowIdentity(entityId, rowId, currentTurnId(ctx), existing?.createdAt ?? endedAt),
      {
        toolCallId: entityId,
        toolName: "bash",
        status: result.cancelled ? "cancelled" : failed ? "error" : "success",
        inputText: existing?.inputText || command,
        input: { command },
        output: {
          text: result.output,
          display: {
            kind: "bash_output",
            output: result.output.slice(0, 150_000),
            truncated: result.truncated,
            ...(result.fullOutputPath ? { outputPath: result.fullOutputPath } : {}),
          },
        },
        ...(failed
          ? { error: { code: "exit_code", message: `exit ${result.exitCode ?? "unknown"}` } }
          : {}),
        ...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
        endedAt,
      },
    ),
  );
}

/** `extension_event`：`nek.state`（完整快照）与 `nek.subagent`（增量）。 */
export function applyExtensionEvent(ctx: NekLiveContext, event: NekExtensionEvent): void {
  if (event.name === "nek.subagent") {
    applySubagentRecord(ctx, event.payload as NekSubagentRecord);
    return;
  }
  if (event.name === "nek.state") {
    const state = event.payload as {
      mode?: string;
      todos?: Array<{ id: string; content: string; status: string }>;
    };
    if (typeof state.mode === "string")
      ctx.store.setState({ config: withNekMode(ctx.store.state.config, state.mode) });
    const items = (state.todos ?? [])
      .filter((todo) => todo.status !== "cancelled")
      .map((todo) => ({
        id: todo.id,
        content: todo.content,
        status:
          todo.status === "in_progress"
            ? ("inProgress" as const)
            : todo.status === "completed"
              ? ("completed" as const)
              : ("pending" as const),
      }));
    ctx.store.setState({ plan: items.length === 0 ? null : { items, updatedAt: ctx.now() } });
  }
}

/** `get_state` 的响应合并进快照字段。 */
export function applySessionState(ctx: NekLiveContext, state: NekRpcSessionState): void {
  const current = ctx.store.state.config;
  ctx.store.setState({
    config: withNekModelSelection({
      ...current,
      provider: state.model?.provider ?? current.provider,
      model: state.model?.id ?? current.model,
      thought: state.thinkingLevel,
    }),
  });
}

import type { NekRpcEvent } from "@zcode/shared/nek-protocol";
import type { NekLiveContext } from "./nekLiveTurn.js";
import { applyTurnLifecycleEvent, closeTurn, createNekLiveContext } from "./nekLiveTurn.js";
import { applyMessageEnd, applyMessageStart, applyMessageUpdate } from "./nekLiveMessages.js";
import {
  applyToolExecutionEnd,
  applyToolExecutionStart,
  applyToolExecutionUpdate,
} from "./nekLiveTools.js";
import {
  applyAppendedEntry,
  applyBashExecutionUpdate,
  applyCompactionEnd,
  applyCompactionStart,
  applyExtensionEvent,
  applyRetryMarker,
} from "./nekLiveMarkers.js";
import { buildQueueItems, withNekModelSelection } from "./nekProjectionSnapshot.js";

export { applySubagentRecord } from "./nekLiveTools.js";
export { applyBashCommandResultRow, applySessionState } from "./nekLiveMarkers.js";
export { closeTurn, createNekLiveContext } from "./nekLiveTurn.js";
export type { NekLiveContext, NekLiveTurn } from "./nekLiveTurn.js";

/**
 * 事件分发：把 nek 的一条 RPC 事件并入投影状态。
 *
 * 只做状态迁移；行的增量（appended/upserted/delta）由 `NekProjectionStore` 统一产生。
 * `extension_error` is owned by the projector's bounded notice ledger, outside turn lifecycle.
 * Other unlisted events do not change rows.
 */
export function applyNekLiveEvent(ctx: NekLiveContext, event: NekRpcEvent): void {
  if (applyTurnLifecycleEvent(ctx, event)) return;
  switch (event.type) {
    case "message_start":
      applyMessageStart(ctx, event.message as never);
      return;
    case "message_update":
      applyMessageUpdate(ctx, event);
      return;
    case "message_end":
      applyMessageEnd(ctx, event.message as never);
      return;
    case "tool_execution_start":
      applyToolExecutionStart(ctx, event.toolCallId, event.toolName, event.args);
      return;
    case "tool_execution_update":
      applyToolExecutionUpdate(
        ctx,
        event.toolCallId,
        event.toolName,
        event.args,
        event.partialResult,
      );
      return;
    case "tool_execution_end":
      applyToolExecutionEnd(ctx, event.toolCallId, event.toolName, event.result, event.isError);
      return;
    case "queue_update":
      ctx.store.setState({
        queue: {
          items: buildQueueItems(event.steering, event.followUp, ctx.now()),
          autoDrain: true,
        },
      });
      return;
    case "thinking_level_changed":
      ctx.store.setState({
        config: withNekModelSelection({
          ...ctx.store.state.config,
          thought: event.level,
        }),
      });
      return;
    case "session_info_changed":
      ctx.store.setState({ title: event.name ?? "" });
      return;
    case "compaction_start":
      applyCompactionStart(ctx, event.reason);
      return;
    case "compaction_end":
      applyCompactionEnd(ctx, event);
      return;
    case "auto_retry_start":
      applyRetryMarker(ctx, event.attempt);
      return;
    case "entry_appended":
      applyAppendedEntry(ctx, event.entry);
      return;
    case "bash_execution_update":
      applyBashExecutionUpdate(ctx, event.id, event.delta);
      return;
    case "extension_event":
      applyExtensionEvent(ctx, event);
      return;
    default:
      return;
  }
}

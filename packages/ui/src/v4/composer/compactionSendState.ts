import { NEK_COMPACTING_INPUT_REASON } from "@zcode/shared/nek-protocol";
import type { InputRouting } from "@zcode/shared/zcode-protocol-v4";

/**
 * 压缩中的输入路由判定。
 *
 * nek 压缩期间不接纳 `prompt` / `steer` / `follow_up`，GUI 因此把输入暂存在
 * 本地待发队列里（`NekAgentService` 是唯一 owner），压缩收口后才提交。
 * 界面只读投影的 `inputRouting`，不另存一份压缩状态。
 */
export function isCompactingInputRouting(
  routing: { reasonCode?: string } | null | undefined,
): boolean {
  return routing?.reasonCode === NEK_COMPACTING_INPUT_REASON;
}

type ComposerSendLabelId = "chat.send" | "chat.queue.enqueue" | "chat.composer.sendAfterCompaction";

/**
 * 发送键文案：压缩中不能说成"加入 CLI 队列"——CLI 侧还没有任何排队事实。
 */
export function resolveComposerSendLabelId(
  routing: Pick<InputRouting, "mode" | "reasonCode"> | null | undefined,
): ComposerSendLabelId {
  if (isCompactingInputRouting(routing)) return "chat.composer.sendAfterCompaction";
  return routing?.mode === "enqueue" ? "chat.queue.enqueue" : "chat.send";
}

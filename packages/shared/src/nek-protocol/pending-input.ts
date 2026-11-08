/**
 * GUI 待发送输入（压缩期间的 pre-submit 暂存）被撤回时的可见错误名。
 *
 * nek 压缩历史期间 GUI 自己持有待发送事实：压缩收口后才交给 CLI。压缩被取消、
 * 会话关闭、进程断线或等待超时都会让这次发送可见失败（草稿回到输入框，绝不迟到重发）。
 * 错误跨 RPC / 渲染边界时只保留 `name` 与 `message`，因此界面按名字判定
 * "待发送被撤回"，不匹配错误文案。
 */
export const NEK_PENDING_INPUT_CANCELLED = "NekPendingInputCancelledError";

/**
 * `inputRouting.reasonCode`：压缩期间接受"未来输入"。
 *
 * 与 CLI 的语义一致（排队而不是打断压缩），但 GUI 侧的排队事实由
 * `NekPendingInputQueue` 持有：压缩收口后才真正发给 nek。
 */
export const NEK_COMPACTING_INPUT_REASON = "compactingAcceptsFutureInput";

export function isNekPendingInputCancelled(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === NEK_PENDING_INPUT_CANCELLED;
}

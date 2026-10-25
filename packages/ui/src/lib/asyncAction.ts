/**
 * 异步动作状态机：异步按钮与即时保存字段共用。
 *
 * idle → pending → success（短暂 ✓ 后 reset 回 idle）/ error（保留原因，下次 start 清除）。
 * pending 期间的重复 start 被忽略，保证不会重复提交。
 */
import { getErrorMessage } from "./errorMessage.js";

/** 成功 ✓ 的展示时长（交互规范 §7.1）。 */
export const ASYNC_SUCCESS_FEEDBACK_MS = 1500;

export type AsyncActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "success" }
  | { status: "error"; message: string };

export type AsyncActionEvent =
  | { type: "start" }
  | { type: "resolve" }
  | { type: "reject"; message: string }
  | { type: "reset" };

export const ASYNC_ACTION_IDLE: AsyncActionState = { status: "idle" };

/** 纯状态迁移；非法迁移返回原状态（引用不变，便于 React 跳过重渲染）。 */
export function reduceAsyncAction(
  state: AsyncActionState,
  event: AsyncActionEvent,
): AsyncActionState {
  switch (event.type) {
    case "start":
      return state.status === "pending" ? state : { status: "pending" };
    case "resolve":
      return state.status === "pending" ? { status: "success" } : state;
    case "reject":
      return state.status === "pending" ? { status: "error", message: event.message } : state;
    case "reset":
      return state.status === "idle" || state.status === "pending" ? state : ASYNC_ACTION_IDLE;
  }
}

/** 把任意抛出值转成可展示的错误文案；空文案用调用方给出的通用文案。 */
export function describeAsyncError(error: unknown, emptyFallbackMessage: string): string {
  const message = getErrorMessage(error);
  return message === "" ? emptyFallbackMessage : message;
}

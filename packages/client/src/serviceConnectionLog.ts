/**
 * 连接级订阅失败收口。
 *
 * `IChannel.listen` 只返回 `Event<T>`：订阅方没有 terminal 回调，帧流死掉与"暂时没有帧"
 * 在类型上不可区分。所以 `ChannelClient.onDidSubscriptionError` 是唯一的失败通道，每个真实
 * 连接（MessagePort / WebSocket / 远端 SSH host）都必须把它接到自己既有的日志通道上，
 * 再由日志层的隐私过滤保留错误类型与源码栈帧。
 *
 * 这里只定义形状与转发，不决定策略：订阅失败不终结连接，一条死流不影响同一连接上的其它
 * channel；需要该流的调用方重新 `listen()` 会拿到新的请求 id，等同于重试。
 */
import { safeLogArgs } from "@zcode/shared";
import type { IChannelSubscriptionFailure } from "@zcode/rpc";

/** 连接级日志出口：renderer 注入既有 main 日志通道，其它宿主可注入自己的 logger。 */
export type ServiceConnectionLog = (level: "info" | "warn" | "error", args: unknown[]) => void;

export interface ServiceConnectionOptions {
  /** 订阅失败的落点；未注入时退回 console，不静默丢弃。 */
  log?: ServiceConnectionLog;
}

/**
 * 订阅失败的唯一上报形状。
 *
 * 只带固定消息与原始错误：channel/event 这类动态标识会被日志层的隐私过滤丢弃，
 * 定位靠错误类型与源码栈帧（与 `[rpc:listen] failed` 同一口径）。
 */
export function reportSubscriptionFailure(
  failure: IChannelSubscriptionFailure,
  log?: ServiceConnectionLog,
): void {
  const args = ["[rpc:subscription] failed", failure.error];
  if (log) {
    log("warn", args);
    return;
  }
  console.warn(...safeLogArgs(args));
}

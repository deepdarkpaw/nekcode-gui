/**
 * 连接级订阅失败收口。
 *
 * `IChannel.listen` 只返回 `Event<T>`：订阅方没有 terminal 回调，帧流死掉与"暂时没有帧"
 * 在类型上不可区分。`ChannelClient.onDidSubscriptionError` 是唯一的失败通道，每个真实连接
 * （MessagePort / WebSocket / 远端 SSH host）都必须把它接到自己既有的处理上：
 *
 * - `onSubscriptionFailure`（**必需**）：用户可见状态与手动重试入口，由宿主接既有提示/连接
 *   状态组件，重试用 `IChannelSubscriptionFailure.retry()` 重新建立同一条订阅；
 * - `log`（可选）：隐私过滤后的诊断日志（保留错误类型与源码栈帧）。
 *
 * 这里只做转发与上报兜底，不决定 UI 策略：订阅失败不终结连接，一条死流不影响同一连接上的
 * 其它 channel 与 RPC。上报本身是旁路——任何一步抛错都不能回到协议分发栈，也不能中断
 * 后续失败与帧投递；上报失败用本包既有的 console 通道记录（过滤后只剩类型与栈帧）。
 */
import { safeLogArgs } from "@zcode/shared";
import type { IChannelSubscriptionFailure } from "@zcode/rpc";

/** 连接级日志出口：renderer 注入既有 main 日志通道，其它宿主可注入自己的 logger。 */
export type ServiceConnectionLog = (level: "info" | "warn" | "error", args: unknown[]) => void;

export interface ServiceConnectionOptions {
  /** 订阅失败的可见状态入口；宿主必须接上（不能只有日志）。 */
  onSubscriptionFailure: (failure: IChannelSubscriptionFailure) => void;
  /** 订阅失败的诊断日志落点。 */
  log?: ServiceConnectionLog;
}

/** 订阅失败的唯一日志形状：固定消息 + 原始错误（channel/event 由日志层隐私过滤丢弃）。 */
function reportSubscriptionFailure(
  failure: IChannelSubscriptionFailure,
  log?: ServiceConnectionLog,
): void {
  if (!log) return;
  try {
    log("warn", ["[rpc:subscription] failed", failure.error]);
  } catch (error) {
    console.error(...safeLogArgs(["[rpc:subscription] log failed", error]));
  }
}

/**
 * 把一个 ChannelClient 的订阅失败接到宿主：先可见状态，再诊断日志。
 *
 * 两步分别收口异常，保证一次上报失败不会中断后续订阅失败与其它 channel 的帧投递。
 */
export function attachSubscriptionFailureHandling(
  client: {
    onDidSubscriptionError(listener: (failure: IChannelSubscriptionFailure) => void): {
      dispose(): void;
    };
  },
  options: ServiceConnectionOptions,
): void {
  client.onDidSubscriptionError((failure) => {
    try {
      options.onSubscriptionFailure(failure);
    } catch (error) {
      console.error(...safeLogArgs(["[rpc:subscription] handler failed", error]));
    }
    reportSubscriptionFailure(failure, options.log);
  });
}

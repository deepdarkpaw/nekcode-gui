import type { CancellationToken, Event } from "./foundation.js";

export interface IChannel {
  call<T>(command: string, arg?: any, cancellationToken?: CancellationToken): Promise<T>;
  listen<T>(event: string, arg?: any): Event<T>;
}

export interface IServerChannel<TContext = string> {
  call<T>(
    ctx: TContext,
    command: string,
    arg?: any,
    cancellationToken?: CancellationToken,
  ): Promise<T>;
  listen<T>(ctx: TContext, event: string, arg?: any): Event<T>;
}

export const enum RequestType {
  Promise = 100,
  PromiseCancel = 101,
  EventListen = 102,
  EventDispose = 103,
}

export const enum ResponseType {
  Initialize = 200,
  PromiseSuccess = 201,
  PromiseError = 202,
  PromiseErrorObj = 203,
  EventFire = 204,
}

/**
 * Promise 失败与事件订阅失败的统一线上错误载荷。
 *
 * 订阅失败必须复用同一形状：客户端只有拿到 name/message/stack 才能定位缺哪个事件，
 * 否则一次订阅失败会变成"连接还在、帧永不到达"的静默悬挂。
 */
export interface IRawErrorPayload {
  message: string;
  name: string;
  stack: string[] | undefined;
  code?: unknown;
  kind?: unknown;
  status?: unknown;
  retryAfterMs?: unknown;
  data?: unknown;
  detail?: unknown;
  details?: unknown;
  taskId?: unknown;
  traceId?: unknown;
}

export type IRawResponse =
  | { type: ResponseType.Initialize }
  | { type: ResponseType.PromiseSuccess; id: number; data: any }
  | { type: ResponseType.PromiseError; id: number; data: IRawErrorPayload }
  | { type: ResponseType.PromiseErrorObj; id: number; data: any }
  | { type: ResponseType.EventFire; id: number; data: any };

/**
 * 服务端拒绝建立事件订阅时通知客户端的事实。
 *
 * 此时该订阅已失效、不会再有帧，但订阅者的回调仍然挂在客户端这一侧：`retry()` 会重新向
 * 服务端建立**同一条逻辑订阅**（新请求 id、同一批监听者），成功后的帧继续投给原订阅者。
 * 调用方不需要（也不应该）自己再造一个没人监听的 emitter。
 */
export interface IChannelSubscriptionFailure {
  /** Unique connection + logical subscription identity; never derived from names or args. */
  readonly id: string;
  /** Monotonic attempt owned by the logical subscription, including synchronous failures. */
  readonly attempt: number;
  /** Fires once when retry, last unsubscribe or connection disposal revokes this capability. */
  readonly onDidInvalidate: Event<void>;
  channelName: string;
  event: string;
  error: Error;
  /** This failure capability is live only until retry, last unsubscribe, or connection disposal. */
  isLive(): boolean;
  /**
   * 重新建立订阅。只在"失败且仍有人监听"时生效，重复调用或被退订后调用都是空操作——
   * 这是手动重试，不会自动循环。
   */
  retry(): void;
}

export type IHandler = (response: IRawResponse) => void;

export interface IChannelServer<TContext = string> {
  registerChannel(channelName: string, channel: IServerChannel<TContext>): void;
  ready?(): void;
}

export interface IChannelClient {
  getChannel<T extends IChannel>(channelName: string): T;
}

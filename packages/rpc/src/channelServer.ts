import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannelServer,
  type IRawErrorPayload,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

/** 跨进程错误只透传这些结构化字段；其余业务对象不进入线上载荷。 */
const ERROR_PASSTHROUGH_KEYS = [
  "code",
  "kind",
  "status",
  "retryAfterMs",
  "data",
  "detail",
  "details",
  "taskId",
  "traceId",
] as const;

/** 把异常折叠成线上错误载荷：message/name/stack 之外只保留白名单字段。 */
export function toRpcErrorPayload(error: Error): IRawErrorPayload {
  const payload: IRawErrorPayload = {
    message: error.message,
    name: error.name,
    stack: error.stack ? error.stack.split("\n") : undefined,
  };
  const record = error as Error & Record<string, unknown>;
  for (const key of ERROR_PASSTHROUGH_KEYS) {
    const value = record[key];
    if (value !== undefined) {
      payload[key] = value;
    }
  }
  return payload;
}

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<
    string,
    { request: any; timer: ReturnType<typeof setTimeout> }[]
  >();
  private protocolListener: IDisposable | null;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type]);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onRawMessage(message: VSBuffer): void {
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as RequestType;

    switch (type) {
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: body,
        });
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    promise
      .then(
        (data) => {
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          this.sendRequestFailure(request.id, error);
        },
      )
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  /**
   * Promise 拒绝与事件订阅失败的统一回包。
   *
   * 订阅失败必须回给客户端而不是抛给协议层：ChannelServer 运行在各进程的消息分发栈里，
   * 一次抛出会变成 uncaughtException 直接杀掉整个 host，连带所有会话与窗口。
   */
  private sendRequestFailure(id: number, error: unknown): void {
    if (error instanceof Error) {
      this.sendResponse({
        id,
        data: toRpcErrorPayload(error),
        type: ResponseType.PromiseError,
      });
      return;
    }

    this.sendResponse({
      id,
      data: error,
      type: ResponseType.PromiseErrorObj,
    });
  }

  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    let disposable: IDisposable;
    try {
      // listen() 自身（未知事件 → ProxyChannel 抛错）与首订阅回调（服务 attach 失败）
      // 都可能抛出，两者都要变成客户端可见的订阅失败。
      disposable = channel.listen(
        this.ctx,
        request.name,
        request.arg,
      )((data) => {
        this.sendResponse({
          id: request.id,
          data,
          type: ResponseType.EventFire,
        });
      });
    } catch (error) {
      this.sendRequestFailure(request.id, error);
      return;
    }
    this.activeRequests.set(request.id, disposable);
  }

  private disposeActiveRequest(id: number): void {
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  private collectPendingRequest(request: any): void {
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    const timer = setTimeout(() => {
      console.error(`Unknown channel: ${request.channelName}`);
      if (request.type !== RequestType.Promise) {
        return;
      }

      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type: ResponseType.PromiseError,
      });
    }, this.timeoutDelay);

    pendingRequests.push({ request, timer });
  }

  private flushPendingRequests(channelName: string): void {
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    for (const { request, timer } of requests) {
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
  }
}

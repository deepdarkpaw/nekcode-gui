import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter, type IDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import {
  type IChannel,
  type IChannelClient,
  type IChannelSubscriptionFailure,
  type IHandler,
  type IRawErrorPayload,
  type IRawResponse,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

enum State {
  Uninitialized,
  Idle,
}

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

/** 把线上错误载荷还原成 Error；与 ChannelServer 的白名单字段一一对应。 */
function createErrorFromPayload(payload: IRawErrorPayload): Error {
  const error = new Error(payload.message) as Error & Record<string, unknown>;
  error.name = payload.name;
  if (payload.stack) {
    error.stack = payload.stack.join("\n");
  }
  for (const key of ERROR_PASSTHROUGH_KEYS) {
    const value = payload[key];
    if (value !== undefined) {
      error[key] = value;
    }
  }
  return error;
}

export class ChannelClient implements IChannelClient, IDisposable {
  private state = State.Uninitialized;
  private isDisposed = false;
  /** 进行中的 Promise 取消令牌与事件订阅；连接终结时统一收口。 */
  private activeRequests = new Set<IDisposable>();
  private handlers = new Map<number, IHandler>();
  // Promise 请求和事件监听共用 handlers，但只有前者需要在连接终结时 reject。
  // 单独维护 reject map，避免 dispose 把事件订阅误当成挂起的 RPC 请求。
  private pendingRejections = new Map<number, (error: Error) => void>();
  private lastRequestId = 0;
  private protocolListener: IDisposable | null;

  private readonly _onDidInitialize = new Emitter<void>();
  readonly onDidInitialize = this._onDidInitialize.event;

  private readonly _onDidSubscriptionError = new Emitter<IChannelSubscriptionFailure>();
  /**
   * 服务端拒绝建立事件订阅时触发。这是订阅失败的**唯一**上报通道：
   *
   * `IChannel.listen` 只返回 `Event<T>`，订阅方没有 terminal 回调，帧流死掉与"暂时没有帧"
   * 在类型上不可区分。因此连接 owner 必须消费这条事件，把它收进既有的诊断/错误通道，
   * 而不是让状态卡与任务列表永久停在加载态。
   *
   * 重试边界：重新 `listen()` 会分配新的请求 id 与新的 emitter，旧流已死不阻塞新订阅。
   */
  readonly onDidSubscriptionError = this._onDidSubscriptionError.event;

  constructor(private protocol: IMessagePassingProtocol) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onBuffer(msg));
  }

  getChannel<T extends IChannel>(channelName: string): T {
    return {
      call: (command: string, arg?: any, cancellationToken?: CancellationToken) => {
        if (this.isDisposed) {
          return Promise.reject(new Error("ChannelClient is disposed"));
        }
        return this.requestPromise(channelName, command, arg, cancellationToken);
      },
      listen: (event: string, arg?: any) => {
        if (this.isDisposed) {
          return Event.None;
        }
        return this.requestEvent(channelName, event, arg);
      },
    } as T;
  }

  private requestPromise(
    channelName: string,
    name: string,
    arg?: any,
    cancellationToken = CancellationToken.None,
  ): Promise<any> {
    const id = this.lastRequestId++;

    if (cancellationToken.isCancellationRequested) {
      return Promise.reject(new Error("Cancelled"));
    }

    let disposable: IDisposable | undefined;
    const result = new Promise<any>((resolve, reject) => {
      this.pendingRejections.set(id, reject);
      const doRequest = () => {
        // dispose/cancel 可能发生在 Initialize 之前；此时不能再把已经 rejected
        // 的请求发送到新连接或已终结的传输上。
        if (this.isDisposed || !this.pendingRejections.has(id)) {
          return;
        }

        const handler: IHandler = (response) => {
          switch (response.type) {
            case ResponseType.PromiseSuccess:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              resolve(response.data);
              return;
            case ResponseType.PromiseError: {
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(createErrorFromPayload(response.data));
              return;
            }
            case ResponseType.PromiseErrorObj:
              this.handlers.delete(id);
              this.pendingRejections.delete(id);
              reject(response.data);
              return;
          }
        };

        this.handlers.set(id, handler);
        this.sendRequest(RequestType.Promise, id, channelName, name, arg);
      };

      if (this.state === State.Idle) {
        doRequest();
      } else {
        this.whenInitialized().then(doRequest);
      }

      disposable = cancellationToken.onCancellationRequested(() => {
        if (!this.pendingRejections.has(id)) {
          return;
        }
        this.sendCancelOrDispose(RequestType.PromiseCancel, id);
        this.handlers.delete(id);
        this.pendingRejections.delete(id);
        reject(new Error("Cancelled"));
      });
      this.activeRequests.add(disposable);
    });

    return result.finally(() => {
      disposable?.dispose();
      if (disposable) {
        this.activeRequests.delete(disposable);
      }
    });
  }

  /**
   * 一条事件订阅的客户端状态机：`idle → pending →（收帧）| failed`。`pending` 表示请求已
   * 发出、服务端没有报错；服务端不为 EventListen 回 ACK，收帧即是成功。
   *
   * 失败时**保留监听者**（不再 dispose emitter），这样 `retry()` 能向服务端重新建立同一条
   * 逻辑订阅并把后续帧继续投给原订阅者。旧实现 dispose emitter 之后，订阅方只剩一条永远
   * 不会有帧的 Event，任何"重试"都只能由调用方另外造一个没人监听的 emitter。
   */
  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    const listeners = new Set<(data: any) => void>();
    let activeId: number | null = null;
    let status: "idle" | "pending" | "failed" = "idle";

    /** 真正发出 EventListen：先登记 handler 与活跃请求，再发送（同步回包也能找到 handler）。 */
    const send = (): void => {
      const id = this.lastRequestId++;
      activeId = id;
      status = "pending";
      this.handlers.set(id, (response) => {
        if (
          response.type === ResponseType.PromiseError ||
          response.type === ResponseType.PromiseErrorObj
        ) {
          // 服务端拒绝订阅：这条流不会再有帧。按 "handler → 活跃请求" 的顺序收口，
          // 同一 id 的第二份错误回包（协议层重复投递）在 handler 删除后自然变成空操作。
          this.handlers.delete(id);
          this.activeRequests.delete(subscription);
          activeId = null;
          status = "failed";
          this._onDidSubscriptionError.fire({
            channelName,
            event: name,
            error:
              response.type === ResponseType.PromiseError
                ? createErrorFromPayload(response.data)
                : new Error(String(response.data)),
            isLive: () => listeners.size > 0,
            retry,
          });
          return;
        }
        for (const listener of Array.from(listeners)) listener((response as { data: any }).data);
      });
      this.activeRequests.add(subscription);
      this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
    };

    /** 首个监听者（或重建后的首个监听者）到来时发出请求；Initialize 之前排队。 */
    const start = (): void => {
      if (this.isDisposed || listeners.size === 0) return;
      if (this.state === State.Idle) {
        send();
        return;
      }
      void this.whenInitialized().then(() => {
        // 排队期间可能被 dispose 或全部退订：不能再向已终结的连接发请求。
        if (this.isDisposed || listeners.size === 0) return;
        send();
      });
    };

    const stop = (): void => {
      if (activeId !== null) {
        // 只有真的向服务端登记过的订阅才需要 EventDispose；失败态服务端本来就没有记录。
        if (!this.isDisposed && status !== "failed") {
          this.sendCancelOrDispose(RequestType.EventDispose, activeId);
        }
        this.handlers.delete(activeId);
        this.activeRequests.delete(subscription);
      }
      activeId = null;
      status = "idle";
    };

    /** 手动重试：只在失败且仍有人监听时重建订阅，不会自动循环。 */
    const retry = (): void => {
      if (this.isDisposed || status !== "failed" || listeners.size === 0) return;
      start();
    };

    const subscription: IDisposable = {
      dispose: () => {
        stop();
        listeners.clear();
      },
    };

    return (listener) => {
      if (this.isDisposed) {
        return { dispose: () => undefined };
      }
      const wasEmpty = listeners.size === 0;
      listeners.add(listener);
      if (wasEmpty) start();
      return {
        dispose: () => {
          if (!listeners.delete(listener)) return;
          if (listeners.size === 0) stop();
        },
      };
    };
  }

  private sendRequest(
    type: RequestType,
    id: number,
    channelName: string,
    name: string,
    arg?: any,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id, channelName, name]);
    serialize(writer, arg);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private sendCancelOrDispose(
    type: RequestType.PromiseCancel | RequestType.EventDispose,
    id: number,
  ): void {
    const writer = new BufferWriter();
    serialize(writer, [type, id]);
    serialize(writer, undefined);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onBuffer(message: VSBuffer): void {
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const body = deserialize(reader);
    const type = header[0] as ResponseType;

    switch (type) {
      case ResponseType.Initialize:
        this.onResponse({ type: ResponseType.Initialize });
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.PromiseErrorObj:
        this.onResponse({
          type,
          id: header[1],
          data: body,
        } as IRawResponse);
        return;
    }
  }

  private onResponse(response: IRawResponse): void {
    if (response.type === ResponseType.Initialize) {
      this.state = State.Idle;
      this._onDidInitialize.fire();
      return;
    }

    this.handlers.get(response.id)?.(response);
  }

  private whenInitialized(): Promise<void> {
    if (this.state === State.Idle) {
      return Promise.resolve();
    }
    return Event.toPromise(this.onDidInitialize);
  }

  dispose(reason?: Error): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.protocolListener?.dispose();
    this.protocolListener = null;

    const rejection = reason ?? new Error("ChannelClient disposed");
    if (!reason) {
      rejection.name = "ConnectionClosed";
    }
    // 传输已终结时，所有已发出以及排队等待 Initialize 的 Promise 请求都必须
    // fail-closed。否则上层的 in-flight 去重 Promise 会永久占用 workspace key。
    for (const [id, reject] of this.pendingRejections) {
      this.pendingRejections.delete(id);
      this.handlers.delete(id);
      reject(rejection);
    }
    for (const disposable of this.activeRequests) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    this.pendingRejections.clear();
    // 事件订阅的 handler 不在 pendingRejections 里，单独清掉，避免终结后的连接继续留表。
    this.handlers.clear();
    this._onDidInitialize.dispose();
    this._onDidSubscriptionError.dispose();
  }
}

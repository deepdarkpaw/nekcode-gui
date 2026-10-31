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

  private requestEvent(channelName: string, name: string, arg?: any): Event<any> {
    const id = this.lastRequestId++;
    const emitter = new Emitter<any>({
      onWillAddFirstListener: () => {
        const doRequest = () => {
          // 与 Promise 请求同一口径：dispose/cancel 可能发生在 Initialize 之前，此时
          // 不能再向已终结的传输发 EventListen，也不能把 emitter 留在 activeRequests 里。
          if (this.isDisposed) {
            return;
          }
          this.activeRequests.add(emitter);
          this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
        };

        if (this.state === State.Idle) {
          doRequest();
        } else {
          this.whenInitialized().then(doRequest);
        }
      },
      onDidRemoveLastListener: () => {
        this.activeRequests.delete(emitter);
        this.sendCancelOrDispose(RequestType.EventDispose, id);
        this.handlers.delete(id);
      },
    });

    // 先登记 handler 再允许订阅：`emitter.event(...)` 的 onWillAddFirstListener 会在订阅
    // 当下就发出 EventListen，同步回包（内存协议、同进程 echo）必须能在这里找到 handler。
    this.handlers.set(id, (response) => {
      if (
        response.type === ResponseType.PromiseError ||
        response.type === ResponseType.PromiseErrorObj
      ) {
        // 服务端拒绝订阅：这条流不会再有帧。按 "handler → 活跃请求 → emitter" 的顺序收口，
        // 保证同一 id 的第二份错误回包（协议层重复投递）在 handler 已被删除后自然变成空操作，
        // 也不会再向服务端发 EventDispose（服务端本来就没登记这条订阅）。
        this.handlers.delete(id);
        this.activeRequests.delete(emitter);
        emitter.dispose();
        this._onDidSubscriptionError.fire({
          channelName,
          event: name,
          error:
            response.type === ResponseType.PromiseError
              ? createErrorFromPayload(response.data)
              : new Error(String(response.data)),
        });
        return;
      }
      emitter.fire((response as { data: any }).data);
    });

    return emitter.event;
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

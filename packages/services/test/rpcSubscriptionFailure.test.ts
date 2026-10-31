/**
 * RPC 事件订阅失败回归。
 *
 * 现场（2026-10-31，打包应用）：渲染层订阅 `zcode-agent.onAgentRuntimeLifecycle`，host 侧
 * `ProxyChannel.listen` 抛 `Event not found`，异常穿过 `ChannelServer.onEventListen` 变成
 * host 的 uncaughtException，整个 host（所有窗口 + 所有会话）一起退出。
 *
 * 这里锁定修复后的收口方式：
 * - 失败只走一套载荷（`IRawErrorPayload` → `IChannelSubscriptionFailure`）与一条恢复通道
 *   （`ChannelClient.onDidSubscriptionError`）；
 * - 一条订阅死掉不影响同一连接上的其它 RPC / 其它订阅，也不抛给订阅方；
 * - 未知 channel 的事件订阅不再"只打日志不回包"地死等；
 * - host 的生产包装（`LoggingChannelServer`）记录首订阅失败，隐私过滤只需错误对象。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BufferWriter,
  ChannelClient,
  ChannelServer,
  Emitter,
  LoggingChannelServer,
  serialize,
  type IChannel,
  type IChannelSubscriptionFailure,
  type IMessagePassingProtocol,
  type VSBuffer,
} from "@zcode/rpc";

interface LinkedPair {
  clientProtocol: IMessagePassingProtocol;
  serverProtocol: IMessagePassingProtocol;
}

/** 内存协议对：一端 send 直接投递到另一端的 onMessage（同步回包）。 */
function createLinkedProtocols(): LinkedPair {
  const toClient = new Emitter<VSBuffer>();
  const toServer = new Emitter<VSBuffer>();
  return {
    serverProtocol: { send: (buffer) => toClient.fire(buffer), onMessage: toServer.event },
    clientProtocol: { send: (buffer) => toServer.fire(buffer), onMessage: toClient.event },
  };
}

function createConnection(
  register: (server: ChannelServer<string>) => void,
  timeoutDelay?: number,
): { client: ChannelClient; server: ChannelServer<string> } {
  const pair = createLinkedProtocols();
  // 客户端先挂上协议监听，否则服务端构造函数发出的 Initialize 会丢，请求永远排队。
  const client = new ChannelClient(pair.clientProtocol);
  const server = new ChannelServer<string>(pair.serverProtocol, "test", timeoutDelay);
  register(server);
  return { client, server };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test("同一事件的多个订阅者各自收帧，互不串号也不产生失败上报", async () => {
  const pair = createLinkedProtocols();
  const client = new ChannelClient(pair.clientProtocol);
  const frameEmitters: Emitter<number>[] = [];
  const server = new ChannelServer<string>(pair.serverProtocol, "test");
  server.registerChannel("svc", {
    async call() {
      return null;
    },
    listen() {
      const emitter = new Emitter<number>();
      frameEmitters.push(emitter);
      return emitter.event;
    },
  });

  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  const remote = client.getChannel<IChannel>("svc");
  const first: number[] = [];
  const second: number[] = [];
  const firstSubscription = remote.listen<number>("onTick")((value) => first.push(value));
  const secondSubscription = remote.listen<number>("onTick")((value) => second.push(value));
  await tick();

  // 渲染层与 host 观察者可以同时订阅同一个事件：谁都拿不到别人的帧。
  assert.equal(frameEmitters.length, 2);
  frameEmitters[0]!.fire(1);
  frameEmitters[1]!.fire(2);
  assert.deepEqual(first, [1]);
  assert.deepEqual(second, [2]);
  assert.deepEqual(failures, []);

  firstSubscription.dispose();
  secondSubscription.dispose();
  client.dispose();
  server.dispose();
});

test("订阅失败回错误包：不抛给订阅方，连接上的其它 RPC 与订阅照常", async () => {
  const failing = new Error("Event not found: onMissing");
  const { client, server } = createConnection((instance) => {
    instance.registerChannel("svc", {
      async call(_ctx, command) {
        return { command };
      },
      listen(_ctx, event) {
        if (event === "onMissing") throw failing;
        const emitter = new Emitter<number>();
        return emitter.event;
      },
    });
  });

  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  const remote = client.getChannel<IChannel>("svc");
  // 同步回包（内存协议在 send 里就投递）时 handler 必须已经登记，这里验证不会抛出。
  assert.doesNotThrow(() => remote.listen("onMissing")(() => undefined));
  await tick();

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.channelName, "svc");
  assert.equal(failures[0]?.event, "onMissing");
  assert.match(failures[0]?.error.message ?? "", /Event not found: onMissing/u);

  // 同一条连接必须继续服务：其它方法、其它订阅都不受影响。
  assert.deepEqual(await remote.call("ping"), { command: "ping" });
  const frames: number[] = [];
  const subscription = remote.listen<number>("onTick")((value) => frames.push(value));
  await tick();
  assert.deepEqual(failures.length, 1);
  subscription.dispose();
  client.dispose();
  server.dispose();
});

test("同一订阅的重复错误回包只上报一次，迟到帧被忽略", async () => {
  const { client, server } = createConnection((instance) => {
    instance.registerChannel("svc", {
      async call() {
        return null;
      },
      listen() {
        throw new Error("attach failed");
      },
    });
  });

  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  const remote = client.getChannel<IChannel>("svc");
  remote.listen("onDidChange")(() => undefined);
  await tick();

  // 服务端只会回一份错误，但协议层重复投递时客户端不能把同一条订阅算成两次失败。
  // 私有入口：测试直接投递第二份错误回包，验证 handler 删除后不会二次上报。
  (client as unknown as { onBuffer(message: VSBuffer): void }).onBuffer(
    encodeErrorResponse(0, { message: "attach failed", name: "Error", stack: undefined }),
  );
  await tick();
  assert.equal(failures.length, 1);
  client.dispose();
  server.dispose();
});

test("未知 channel 的事件订阅在超时后回错误包，不再是死流", async () => {
  const { client, server } = createConnection(() => undefined, 5);
  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));

  // 服务端找不到 channel 时只把请求挂进 pending（唯一日志是 console.error），
  // 之前对 EventListen 直接返回，订阅方永远等不到帧也等不到失败。
  const originalError = console.error;
  console.error = () => undefined;
  try {
    client.getChannel<IChannel>("never-registered").listen("onTick")(() => undefined);
    await tick(30);
  } finally {
    console.error = originalError;
  }

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.channelName, "never-registered");
  assert.match(failures[0]?.error.message ?? "", /timed out after 5ms/u);
  client.dispose();
  server.dispose();
});

test("host 的 LoggingChannelServer 记录首订阅失败，并把失败照原样回给客户端", async () => {
  const logged: unknown[][] = [];
  const pair = createLinkedProtocols();
  const client = new ChannelClient(pair.clientProtocol);
  const rawServer = new ChannelServer<string>(pair.serverProtocol, "test");
  const loggedServer = new LoggingChannelServer(rawServer, (...args: unknown[]) => {
    logged.push(args);
  });
  const failing = new Error("attach failed");
  loggedServer.registerChannel("svc", {
    async call() {
      return null;
    },
    listen() {
      // 未知事件在 ProxyChannel 里是同步抛错；服务 attach 失败则在首订阅回调里抛出。
      return () => {
        throw failing;
      };
    },
  });

  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  client.getChannel<IChannel>("svc").listen("onDidChange")(() => undefined);
  await tick();

  assert.equal(failures.length, 1);
  // 生产日志只保留固定消息 + 错误对象（隐私过滤后是 errorType 与源码栈帧）。
  const failureLog = logged.find((args) => args[0] === "[rpc:listen] failed");
  assert.ok(failureLog, "expected [rpc:listen] failed log");
  assert.equal(failureLog[1], failing);
  client.dispose();
  rawServer.dispose();
});

test("客户端 dispose 之后不再上报订阅失败", async () => {
  const { client, server } = createConnection((instance) => {
    instance.registerChannel("svc", {
      async call() {
        return null;
      },
      listen() {
        throw new Error("attach failed");
      },
    });
  });
  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  client.getChannel<IChannel>("svc").listen("onDidChange")(() => undefined);
  await tick();
  assert.equal(failures.length, 1);

  client.dispose();
  // dispose 之后 getChannel().listen() 返回 Event.None：既不抛错，也不会上报。
  const afterDispose = client.getChannel<IChannel>("svc").listen("onDidChange");
  assert.doesNotThrow(() => afterDispose(() => undefined));
  await tick();
  assert.equal(failures.length, 1);
  server.dispose();
});

test("Initialize 与 dispose 同 tick：排队中的订阅不再发 EventListen，也不上报失败", async () => {
  let sentCount = 0;
  const inbound = new Emitter<VSBuffer>();
  const client = new ChannelClient({
    send: () => {
      sentCount += 1;
    },
    onMessage: inbound.event,
  });

  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  // Initialize 还没到：订阅进入 whenInitialized() 的排队队列。
  client.getChannel<IChannel>("svc").listen("onTick")(() => undefined);
  assert.equal(sentCount, 0);

  // Initialize 到达，它的 `.then(doRequest)` 仍排在微任务队列里；同一 tick 里 dispose。
  inbound.fire(encodeInitialize());
  client.dispose();
  await tick();

  // 旧实现会在微任务里继续向已终结的传输发 EventListen，并把 emitter 留在 activeRequests。
  assert.equal(sentCount, 0);
  assert.deepEqual(failures, []);
});

/** 构造服务端 Initialize 回包：`[ResponseType.Initialize]` + 空 body。 */
function encodeInitialize(): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, [200]);
  serialize(writer, undefined);
  return writer.buffer;
}

/**
 * 直接构造一份线上错误回包，用来验证重复投递的安全性。
 *
 * 形状与 `ChannelServer.sendResponse` 完全一致：`[type, id]` + body 两段序列化。
 */
function encodeErrorResponse(id: number, data: unknown): VSBuffer {
  const writer = new BufferWriter();
  // 与 `ResponseType.PromiseError` 对齐；该 enum 不从包根入口导出。
  serialize(writer, [202, id]);
  serialize(writer, data);
  return writer.buffer;
}

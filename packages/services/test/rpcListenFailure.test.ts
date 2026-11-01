/**
 * host 崩溃回归：事件订阅失败必须回给客户端，不能抛回协议栈。
 *
 * 现场（2026-10-31 打包应用）：渲染层订阅 `zcode-agent.onAgentRuntimeLifecycle`，
 * nek adapter 当时没有这个成员，`ProxyChannel.fromService(...).listen` 抛
 * `Event not found`，异常穿过 ChannelServer.onEventListen 的同步栈，最终变成 host 的
 * uncaughtException，整个 host 进程退出（所有窗口、所有会话一起死）。
 * 这里锁定三点：服务端只回错误、客户端拿到 onDidSubscriptionError、连接仍然可用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  ProxyChannel,
  type IChannel,
  type IMessagePassingProtocol,
  type IServerChannel,
  type VSBuffer,
} from "@zcode/rpc";

interface LinkedPair {
  clientProtocol: IMessagePassingProtocol;
  serverProtocol: IMessagePassingProtocol;
}

/** 内存协议对：一端 send 直接投递到另一端的 onMessage。 */
function createLinkedProtocols(): LinkedPair {
  const toClient = new Emitter<VSBuffer>();
  const toServer = new Emitter<VSBuffer>();
  return {
    serverProtocol: { send: (buffer) => toClient.fire(buffer), onMessage: toServer.event },
    clientProtocol: { send: (buffer) => toServer.fire(buffer), onMessage: toClient.event },
  };
}

function createConnection(register: (server: ChannelServer<string>) => void): {
  client: ChannelClient;
  server: ChannelServer<string>;
} {
  const pair = createLinkedProtocols();
  // 客户端先挂上协议监听，否则服务端构造函数发出的 Initialize 会丢，请求永远排队。
  const client = new ChannelClient(pair.clientProtocol);
  const server = new ChannelServer<string>(pair.serverProtocol, "test");
  register(server);
  return { client, server };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

test("listen 抛错时服务端回错误，客户端收到订阅失败且连接仍可用", async () => {
  const boom = new Error("Event not found: onDynamicMissing");
  const channel: IServerChannel<string> = {
    async call() {
      return { ok: true };
    },
    listen() {
      throw boom;
    },
  };
  const { client, server } = createConnection((instance) =>
    instance.registerChannel("zcode-agent", channel),
  );

  const failures: { channelName: string; event: string; error: Error }[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));

  const remote = client.getChannel<IChannel>("zcode-agent");
  // 服务端把失败回了错误包，客户端因此不会把异常抛给调用方（渲染层订阅是同步 API）。
  assert.doesNotThrow(() => remote.listen("onDynamicMissing")());
  await tick();

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.channelName, "zcode-agent");
  assert.equal(failures[0]?.event, "onDynamicMissing");
  assert.match(failures[0]?.error.message ?? "", /Event not found: onDynamicMissing/u);

  // 同一条连接必须继续服务：host 没有因为订阅失败退出。
  assert.deepEqual(await remote.call("ping"), { ok: true });
  client.dispose();
  server.dispose();
});

test("首订阅回调抛错也走同一条错误回包路径", async () => {
  const channel: IServerChannel<string> = {
    async call() {
      return null;
    },
    listen() {
      return () => {
        throw new Error("attach failed");
      };
    },
  };
  const { client, server } = createConnection((instance) =>
    instance.registerChannel("subagents", channel),
  );

  const failures: Error[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure.error));
  assert.doesNotThrow(() => client.getChannel<IChannel>("subagents").listen("onDidChange")());
  await tick();

  assert.equal(failures.length, 1);
  assert.match(failures[0]?.message ?? "", /attach failed/u);
  client.dispose();
  server.dispose();
});

test("ProxyChannel 缺成员时只让该订阅失败，后续合法订阅照常建立", async () => {
  const service = {
    async ping() {
      return "pong";
    },
    onAgentRuntimeRestarted: () => ({ dispose: () => undefined }),
  };
  const { client, server } = createConnection((instance) =>
    instance.registerChannel("proxy", ProxyChannel.fromService(service)),
  );

  const failures: string[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure.event));
  // 渲染层的真实路径：ProxyChannel.toService 对任何 onX 都返回函数，能力探测在 RPC
  // 边界上不可信，所以缺成员必须由服务端回错——这就是本次 host 崩溃的形态。
  const proxy = ProxyChannel.toService<{
    onAgentRuntimeLifecycle(listener: () => void): { dispose(): void };
    onAgentRuntimeRestarted(listener: () => void): { dispose(): void };
  }>(client.getChannel<IChannel>("proxy"));

  assert.doesNotThrow(() => proxy.onAgentRuntimeLifecycle(() => undefined));
  await tick();
  assert.deepEqual(failures, ["onAgentRuntimeLifecycle"]);

  let restarted = 0;
  assert.doesNotThrow(() =>
    proxy.onAgentRuntimeRestarted(() => {
      restarted += 1;
    }),
  );
  await tick();
  assert.equal(failures.length, 1);
  assert.equal(restarted, 0);
  client.dispose();
  server.dispose();
});

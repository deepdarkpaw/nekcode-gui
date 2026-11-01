import assert from "node:assert/strict";
import { test } from "vitest";
import { RemoteServiceAccess } from "@zcode/client";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  Event,
  LoggingChannelServer,
  ProxyChannel,
  type IChannel,
  type IChannelSubscriptionFailure,
  type VSBuffer,
} from "@zcode/rpc";
import {
  ServiceCollection,
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
} from "@zcode/services";

function link() {
  const inbound = new Emitter<VSBuffer>();
  const outbound = new Emitter<VSBuffer>();
  const client = new ChannelClient({ onMessage: inbound.event, send: (b) => outbound.fire(b) });
  const server = new ChannelServer(
    { onMessage: outbound.event, send: (b) => inbound.fire(b) },
    "relay",
  );
  return {
    client,
    server,
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
}

/** Mirrors SSH ChannelClient -> RemoteServiceAccess -> scoped ServiceCollection -> renderer RPC. */
function relay(eventName: string, scoped = true) {
  const ssh = link();
  const renderer = link();
  let blocked = true;
  let listens = 0;
  let detachments = 0;
  const sink = new Emitter<number>();
  let failUpstream: ((error: Error) => void) | undefined;
  ssh.server.registerChannel(IZCodeAgentService.channelName, {
    call: async <T>() => "pong" as T,
    listen<T>(_context: string, event: string): Event<T> {
      if (event !== eventName) return Event.None;
      listens += 1;
      if (blocked) throw new Error("remote attach failed");
      return (listener, onError) => {
        failUpstream = onError;
        const lease = sink.event((value) => listener(value as T));
        return {
          dispose() {
            detachments += 1;
            lease.dispose();
          },
        };
      };
    },
  });
  const remote = new RemoteServiceAccess(ssh.client);
  const scope = scoped
    ? createZCodeAgentConnectionScope(remote.zcodeAgentService, {
        connectionId: "renderer-attachment",
        clientMode: "desktop-continuous",
      })
    : undefined;
  const internalObserverListens = listens;
  const services = new ServiceCollection().register(
    IZCodeAgentService,
    scope?.service ?? remote.zcodeAgentService,
  );
  const logs: string[] = [];
  services.exposeOnChannelServer(
    new LoggingChannelServer(renderer.server, (message) => logs.push(message)),
  );
  const failures: IChannelSubscriptionFailure[] = [];
  renderer.client.onDidSubscriptionError((failure) => failures.push(failure));
  return {
    channel: renderer.client.getChannel<IChannel>(IZCodeAgentService.channelName),
    failures,
    logs,
    sink,
    listens: () => listens - internalObserverListens,
    detachments: () => detachments,
    allow() {
      blocked = false;
    },
    fail() {
      failUpstream?.(new Error("remote stream failed"));
    },
    dispose() {
      renderer.dispose();
      scope?.dispose();
      ssh.dispose();
    },
  };
}

for (const event of [
  "onAgentRuntimeLifecycle",
  "onDynamicNekStatusFrame",
  "onDynamicNekInteractionFrame",
]) {
  test(`RPC-SSH1: ${event} failure crosses the actual proxy path and retries the original consumer`, async () => {
    const connection = relay(event);
    try {
      const frames: number[] = [];
      const lease = connection.channel.listen<number>(event, { workspacePath: "/mock" })((value) =>
        frames.push(value),
      );
      assert.equal(connection.failures.length, 1);
      assert.match(connection.failures[0]!.error.message, /remote attach failed/u);
      assert.equal(connection.failures[0]!.isLive(), true);
      assert.equal(connection.listens(), 1);
      assert.equal(await connection.channel.call("ping"), "pong");
      connection.allow();
      connection.failures[0]!.retry();
      assert.equal(connection.listens(), 2);
      connection.sink.fire(7);
      assert.deepEqual(frames, [7]);
      // A later remote error follows the same packet path, not SSH-disconnected semantics.
      connection.fail();
      assert.equal(connection.failures.length, 2);
      assert.equal(connection.failures[1]!.id, connection.failures[0]!.id);
      assert.equal(connection.failures[1]!.attempt, 2);
      assert.equal(await connection.channel.call("ping"), "pong");
      connection.failures[1]!.retry();
      assert.equal(connection.listens(), 3);
      connection.sink.fire(8);
      assert.deepEqual(frames, [7, 8]);
      lease.dispose();
      assert.equal(connection.detachments(), 2);
      assert.ok(connection.logs.includes("[rpc:listen] failed"));
    } finally {
      connection.dispose();
    }
  });
}

for (const event of [
  "onDynamicConversationFrame",
  "onDynamicSessionsIndexFrame",
  "onDynamicWorkspaceConfigFrame",
]) {
  test(`RPC-SSH2: routed ${event} evicts a failed route so renderer retry reattaches upstream`, async () => {
    const connection = relay(event);
    try {
      const lease = connection.channel.listen(event, { workspacePath: "/mock" })(() => undefined);
      assert.equal(connection.failures.length, 1);
      assert.equal(connection.listens(), 1);
      connection.failures[0]!.retry();
      assert.equal(connection.failures.length, 2);
      assert.equal(connection.listens(), 2);
      connection.allow();
      connection.failures[1]!.retry();
      assert.equal(connection.listens(), 3);
      connection.fail();
      assert.equal(connection.failures.length, 3);
      connection.failures[2]!.retry();
      assert.equal(connection.listens(), 4);
      assert.equal(connection.failures.length, 3);
      assert.equal(await connection.channel.call("ping"), "pong");
      lease.dispose();
    } finally {
      connection.dispose();
    }
  });
}

test("RPC-SSH4: a local routed Event throwing on attach does not leave a poisoned route cache", () => {
  let attempts = 0;
  const base = ProxyChannel.toService<IZCodeAgentService>({
    call: async <T>() => null as T,
    listen: <T>(event: string): Event<T> => {
      if (event !== "onDynamicConversationFrame") return Event.None;
      return () => {
        attempts += 1;
        throw new Error("local attach failed");
      };
    },
  });
  const scope = createZCodeAgentConnectionScope(base, {
    connectionId: "local",
    clientMode: "desktop-continuous",
  });
  const errors: Error[] = [];
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      scope.service.onDynamicConversationFrame({ workspacePath: "/mock" })(
        () => undefined,
        (error) => errors.push(error),
      );
    }
    assert.equal(attempts, 2);
    assert.equal(errors.length, 2);
  } finally {
    scope.dispose();
  }
});

test("RPC-PROXY1: failed first registration leaves no buffering lease; retry preserves synchronous frames", () => {
  const connection = link();
  let blocked = true;
  let listens = 0;
  let disposed = 0;
  connection.server.registerChannel(
    "svc",
    ProxyChannel.fromService({
      onTick(listener: (value: number) => void) {
        listens += 1;
        if (blocked) throw new Error("initial attach failed");
        listener(42);
        return {
          dispose() {
            disposed += 1;
          },
        };
      },
    }),
  );
  const failures: IChannelSubscriptionFailure[] = [];
  connection.client.onDidSubscriptionError((failure) => failures.push(failure));
  const frames: number[] = [];
  try {
    const event = connection.client.getChannel<IChannel>("svc").listen<number>("onTick");
    const lease = event((value) => frames.push(value));
    assert.equal(failures.length, 1);
    failures[0]!.retry();
    assert.equal(failures.length, 2);
    assert.equal(listens, 2);
    blocked = false;
    failures[1]!.retry();
    assert.equal(listens, 3);
    assert.deepEqual(frames, [42]);
    lease.dispose();
    assert.equal(disposed, 1);
  } finally {
    connection.dispose();
  }
});

test("RPC-SSH3: unscoped remote service path forwards dynamic failure without a second IPC channel", () => {
  const connection = relay("onDynamicNekStatusFrame", false);
  try {
    const frames: number[] = [];
    connection.channel.listen<number>("onDynamicNekStatusFrame", { workspacePath: "/mock" })(
      (value) => frames.push(value),
    );
    assert.equal(connection.failures.length, 1);
    connection.allow();
    connection.failures[0]!.retry();
    connection.sink.fire(1);
    assert.deepEqual(frames, [1]);
  } finally {
    connection.dispose();
  }
});

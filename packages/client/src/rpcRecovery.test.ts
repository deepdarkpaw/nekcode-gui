import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BufferReader,
  BufferWriter,
  ChannelClient,
  ChannelServer,
  Emitter,
  deserialize,
  serialize,
  type Event,
  type IChannel,
  type IChannelSubscriptionFailure,
  type IServerChannel,
  type VSBuffer,
} from "@zcode/rpc";

const connections: { dispose(): void }[] = [];

/** Real serialization and synchronous protocol delivery expose request/response reentrancy. */
function memoryConnection(initialized = true) {
  const inbound = new Emitter<VSBuffer>();
  const outbound = new Emitter<VSBuffer>();
  const sent: number[][] = [];
  let sendError: Error | undefined;
  const client = new ChannelClient({
    onMessage: inbound.event,
    send(buffer) {
      sent.push(deserialize(new BufferReader(buffer)) as number[]);
      if (sendError) throw sendError;
      outbound.fire(buffer);
    },
  });
  const server = new ChannelServer(
    { onMessage: outbound.event, send: (b) => inbound.fire(b) },
    "test",
    10,
    true,
  );
  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  if (initialized) server.ready();
  const result = {
    client,
    server,
    failures,
    sent,
    setSendError(error?: Error) {
      sendError = error;
    },
    respond(type: number, id: number, data: unknown) {
      const writer = new BufferWriter();
      serialize(writer, [type, id]);
      serialize(writer, data);
      inbound.fire(writer.buffer);
    },
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
  connections.push(result);
  return result;
}

function register(
  connection: ReturnType<typeof memoryConnection>,
  listen: IServerChannel["listen"],
): void {
  connection.server.registerChannel("svc", { call: async <T>() => "pong" as T, listen });
}

function eventIds(connection: ReturnType<typeof memoryConnection>): number[] {
  return connection.sent.filter((header) => header[0] === 102).map((header) => header[1]!);
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RPC recovery ownership specifications", () => {
  it("RPC-1: pre-Initialize unsubscribe/resubscribe admits exactly one attempt and disposes its id", async () => {
    const connection = memoryConnection(false);
    const sink = new Emitter<number>();
    const attach = vi.fn(() => sink.event as Event<unknown>);
    register(connection, attach as IServerChannel["listen"]);
    const event = connection.client.getChannel<IChannel>("svc").listen<number>("onTick");
    event(() => undefined).dispose();
    const values: number[] = [];
    const lease = event((value) => values.push(value));
    connection.server.ready();
    await Promise.resolve();
    expect(eventIds(connection)).toHaveLength(1);
    expect(attach).toHaveBeenCalledTimes(1);
    sink.fire(7);
    expect(values).toEqual([7]);
    lease.dispose();
    expect(connection.sent.at(-1)).toEqual([103, eventIds(connection)[0]]);
    sink.fire(8);
    expect(values).toEqual([7]);
  });

  it("RPC-2: duplicate callback registrations are independent leases, including idempotent disposal", () => {
    const connection = memoryConnection();
    const sink = new Emitter<number>();
    register(connection, () => sink.event as Event<never>);
    const event = connection.client.getChannel<IChannel>("svc").listen<number>("onTick");
    const listener = vi.fn();
    const first = event(listener);
    const second = event(listener);
    sink.fire(1);
    expect(listener).toHaveBeenCalledTimes(2);
    first.dispose();
    first.dispose();
    sink.fire(2);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(connection.sent.filter((header) => header[0] === 103)).toHaveLength(0);
    second.dispose();
    expect(connection.sent.filter((header) => header[0] === 103)).toHaveLength(1);
  });

  it("RPC-3: throwing listener does not truncate siblings or fail the stream", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connection = memoryConnection();
    const sink = new Emitter<number>();
    register(connection, () => sink.event as Event<never>);
    const event = connection.client.getChannel<IChannel>("svc").listen<number>("onTick");
    event(() => {
      throw new Error("consumer failed");
    });
    const healthy = vi.fn();
    event(healthy);
    sink.fire(9);
    expect(healthy).toHaveBeenCalledWith(9);
    expect(log).toHaveBeenCalledWith("[rpc:subscription] listener failed", expect.any(Error));
    expect(connection.failures).toEqual([]);
  });

  it("RPC-4: synchronous send failure and retry failure settle with RPC-owned attempts, then recover", async () => {
    const connection = memoryConnection();
    const sink = new Emitter<number>();
    register(connection, () => sink.event as Event<never>);
    connection.setSendError(new Error("send failed"));
    const values: number[] = [];
    connection.client.getChannel<IChannel>("svc").listen<number>("onTick")((value) =>
      values.push(value),
    );
    const first = connection.failures[0]!;
    const invalidated = vi.fn();
    first.onDidInvalidate(invalidated);
    first.retry();
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(first.isLive()).toBe(false);
    expect(connection.failures.map((failure) => failure.attempt)).toEqual([1, 2]);
    expect(connection.failures[1]!.id).toBe(first.id);
    await expect(connection.client.getChannel<IChannel>("svc").call("ping")).rejects.toThrow(
      "send failed",
    );
    connection.setSendError();
    connection.failures[1]!.retry();
    first.retry();
    sink.fire(42);
    expect(eventIds(connection)).toHaveLength(3);
    expect(values).toEqual([42]);
  });

  it("RPC-5: failed and waiting subscriptions remain owned until dispose; captured Events cannot revive", async () => {
    const connection = memoryConnection();
    register(connection, () => {
      throw new Error("attach failed");
    });
    const event = connection.client.getChannel<IChannel>("svc").listen("onTick");
    event(() => undefined);
    const failure = connection.failures[0]!;
    const invalidate = vi.fn();
    failure.onDidInvalidate(invalidate);
    connection.client.dispose();
    expect(failure.isLive()).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(1);
    failure.retry();
    event(() => undefined);
    expect(eventIds(connection)).toHaveLength(1);

    const waiting = memoryConnection(false);
    waiting.client.getChannel<IChannel>("svc").listen("onTick")(() => undefined);
    waiting.server.ready();
    waiting.client.dispose();
    await Promise.resolve();
    expect(eventIds(waiting)).toHaveLength(0);
  });

  it("RPC-6: connections and different args on the same event have distinct stable identities", () => {
    const first = memoryConnection();
    const second = memoryConnection();
    for (const connection of [first, second]) {
      register(connection, () => {
        throw new Error("attach failed");
      });
      for (const workspace of ["a", "b"]) {
        connection.client.getChannel<IChannel>("svc").listen("onTick", { workspace })(
          () => undefined,
        );
      }
    }
    expect(new Set([...first.failures, ...second.failures].map((failure) => failure.id)).size).toBe(
      4,
    );
    const failure = first.failures[0]!;
    failure.retry();
    expect(first.failures.at(-1)!.id).toBe(failure.id);
    expect(first.failures.at(-1)!.attempt).toBe(2);
  });

  it("RPC-7: duplicate errors and late frames have no authority over a new attempt", () => {
    const connection = memoryConnection();
    let blocked = true;
    const sink = new Emitter<number>();
    register(connection, () => {
      if (blocked) throw new Error("attach failed");
      return sink.event as Event<never>;
    });
    const values: number[] = [];
    connection.client.getChannel<IChannel>("svc").listen<number>("onTick")((value) =>
      values.push(value),
    );
    const oldId = eventIds(connection)[0]!;
    blocked = false;
    connection.failures[0]!.retry();
    connection.respond(202, oldId, { message: "duplicate", name: "Error" });
    connection.respond(204, oldId, 123);
    sink.fire(5);
    expect(connection.failures).toHaveLength(1);
    expect(values).toEqual([5]);
  });

  it("RPC-9: failure and invalidation observers cannot interrupt sibling delivery or disposal", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const connection = memoryConnection();
    register(connection, () => {
      throw new Error("failed");
    });
    connection.client.onDidSubscriptionError(() => {
      throw new Error("bad observer");
    });
    const healthy = vi.fn();
    connection.client.onDidSubscriptionError(healthy);
    connection.client.getChannel<IChannel>("svc").listen("onTick")(() => undefined);
    expect(healthy).toHaveBeenCalledTimes(1);
    const failure = connection.failures[0]!;
    failure.onDidInvalidate(() => {
      throw new Error("bad cleanup");
    });
    const cleanup = vi.fn();
    failure.onDidInvalidate(cleanup);
    expect(() => connection.client.dispose()).not.toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(failure.isLive()).toBe(false);
  });

  it("RPC-10: a synchronous frame during pending flush can cancel a later queued lease", async () => {
    vi.useFakeTimers();
    const connection = memoryConnection();
    const channel = connection.client.getChannel<IChannel>("svc");
    let cancelLater: () => void = () => undefined;
    channel.listen<number>("onTick")(() => cancelLater());
    const later = channel.listen<number>("onTick")(() => undefined);
    cancelLater = () => later.dispose();
    let attaches = 0;
    register(
      connection,
      <T>(): Event<T> =>
        (listener) => {
          attaches += 1;
          listener(1 as T);
          return { dispose() {} };
        },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(attaches).toBe(1);
    expect(connection.failures).toEqual([]);
  });

  it("RPC-8: cancelled/timed-out/disposed unknown-channel requests cannot revive on registration", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cancelled = memoryConnection();
    cancelled.client
      .getChannel<IChannel>("svc")
      .listen("onTick")(() => undefined)
      .dispose();
    const expired = memoryConnection();
    expired.client.getChannel<IChannel>("svc").listen("onTick")(() => undefined);
    const disposed = memoryConnection();
    disposed.client.getChannel<IChannel>("svc").listen("onTick")(() => undefined);
    disposed.server.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(cancelled.failures).toHaveLength(0);
    expect(expired.failures).toHaveLength(1);
    expect(disposed.failures).toHaveLength(0);
    const attach = vi.fn(() => new Emitter<unknown>().event);
    register(cancelled, attach as IServerChannel["listen"]);
    register(expired, attach as IServerChannel["listen"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(attach).not.toHaveBeenCalled();
  });
});

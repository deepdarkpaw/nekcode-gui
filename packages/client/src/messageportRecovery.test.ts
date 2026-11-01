import { describe, expect, it } from "vitest";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  type Event,
  type IChannel,
  type IChannelSubscriptionFailure,
} from "@zcode/rpc";

/** Ordered RPC barriers replace sleeps/polling; no Electron or external service is involved. */
function connection() {
  const { port1, port2 } = new MessageChannel();
  const clientProtocol = new MessagePortProtocol(port1);
  const serverProtocol = new MessagePortProtocol(port2);
  const client = new ChannelClient(clientProtocol);
  const server = new ChannelServer(serverProtocol, "messageport", 1000, true);
  const failures: IChannelSubscriptionFailure[] = [];
  client.onDidSubscriptionError((failure) => failures.push(failure));
  return {
    client,
    server,
    failures,
    dispose() {
      client.dispose();
      server.dispose();
      clientProtocol.disconnect();
      serverProtocol.disconnect();
    },
  };
}

describe("deterministic MessagePort recovery", () => {
  it("RPC-MP1: initialization churn, duplicate leases, failed retry, frames and disposal share one stream", async () => {
    const harness = connection();
    let listens = 0;
    let blocked = true;
    const sink = new Emitter<number>();
    harness.server.registerChannel("svc", {
      call: async <T>() => null as T,
      listen<T>() {
        listens += 1;
        if (blocked) throw new Error("blocked");
        return sink.event as Event<T>;
      },
    });
    try {
      const channel = harness.client.getChannel<IChannel>("svc");
      const event = channel.listen<number>("onTick");
      event(() => undefined).dispose();
      const values: number[] = [];
      const listener = (value: number) => values.push(value);
      const first = event(listener);
      const second = event(listener);
      harness.server.ready();
      await channel.call("barrier");
      expect(listens).toBe(1);
      expect(harness.failures).toHaveLength(1);
      harness.failures[0]!.retry();
      await channel.call("barrier");
      expect(harness.failures.map((failure) => failure.attempt)).toEqual([1, 2]);
      blocked = false;
      harness.failures[1]!.retry();
      await channel.call("barrier");
      sink.fire(42);
      await channel.call("barrier");
      expect(values).toEqual([42, 42]);
      first.dispose();
      sink.fire(43);
      await channel.call("barrier");
      expect(values).toEqual([42, 42, 43]);
      second.dispose();
      await channel.call("barrier");
      sink.fire(44);
      await channel.call("barrier");
      expect(values).toEqual([42, 42, 43]);
      expect(listens).toBe(3);
    } finally {
      harness.dispose();
    }
  });

  it("RPC-MP2: disposing a failed connection immediately revokes UI capabilities", async () => {
    const harness = connection();
    harness.server.registerChannel("svc", {
      call: async <T>() => null as T,
      listen() {
        throw new Error("blocked");
      },
    });
    try {
      const channel = harness.client.getChannel<IChannel>("svc");
      channel.listen("onTick")(() => undefined);
      harness.server.ready();
      await channel.call("barrier");
      const failure = harness.failures[0]!;
      let invalidations = 0;
      failure.onDidInvalidate(() => {
        invalidations += 1;
      });
      harness.client.dispose();
      expect(failure.isLive()).toBe(false);
      expect(invalidations).toBe(1);
      failure.retry();
      expect(harness.failures).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });
});

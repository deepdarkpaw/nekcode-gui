import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  type IChannel,
  type IChannelSubscriptionFailure,
  type VSBuffer,
} from "@zcode/rpc";
import {
  MAX_RPC_SUBSCRIPTION_FAULTS,
  clearRpcSubscriptionFaults,
  dismissRpcSubscriptionFault,
  registerRpcSubscriptionFault,
  retryRpcSubscriptionFault,
  useRpcSubscriptionFaultStore,
} from "./rpcSubscriptionFaultStore.js";

const read = () => useRpcSubscriptionFaultStore.getState().faults;

function fault(id: string, attempt = 1) {
  const invalidated = new Emitter<void>();
  const release = vi.fn();
  const failure: IChannelSubscriptionFailure = {
    id,
    attempt,
    channelName: "svc",
    event: "onTick",
    error: new Error("failed"),
    retry: vi.fn(),
    isLive: () => true,
    onDidInvalidate(listener) {
      const lease = invalidated.event(listener);
      return {
        dispose() {
          release();
          lease.dispose();
        },
      };
    },
  };
  return { failure, release, invalidate: () => invalidated.fire() };
}

/** Store consumes actual synchronous RPC failure/revocation contracts, not reconstructed attempts. */
function rpc() {
  const inbound = new Emitter<VSBuffer>();
  const outbound = new Emitter<VSBuffer>();
  const client = new ChannelClient({ onMessage: inbound.event, send: (b) => outbound.fire(b) });
  const server = new ChannelServer(
    { onMessage: outbound.event, send: (b) => inbound.fire(b) },
    "ui",
  );
  server.registerChannel("svc", {
    call: async <T>() => null as T,
    listen() {
      throw new Error("failed");
    },
  });
  client.onDidSubscriptionError(registerRpcSubscriptionFault);
  return {
    client,
    server,
    channel: client.getChannel<IChannel>("svc"),
    dispose() {
      client.dispose();
      server.dispose();
    },
  };
}

describe("rpcSubscriptionFaultStore ownership specifications", () => {
  beforeEach(clearRpcSubscriptionFaults);
  afterEach(clearRpcSubscriptionFaults);

  it("RPC-UI1: attempts belong to RPC; replacing a capability releases its old observer", () => {
    const first = fault("a", 1);
    const next = fault("a", 2);
    registerRpcSubscriptionFault(first.failure);
    registerRpcSubscriptionFault(next.failure);
    expect(read().map((item) => [item.id, item.attempt])).toEqual([["a", 2]]);
    expect(first.release).toHaveBeenCalledTimes(1);
    first.invalidate();
    expect(read()).toHaveLength(1);
    next.invalidate();
    expect(read()).toEqual([]);
    expect(next.release).toHaveBeenCalledTimes(1);
  });

  it("RPC-UI2: at most eight entries and invalidation observers; eviction and clear release them", () => {
    const fixtures = Array.from({ length: MAX_RPC_SUBSCRIPTION_FAULTS + 3 }, (_, index) =>
      fault(`f${index}`),
    );
    for (const fixture of fixtures) registerRpcSubscriptionFault(fixture.failure);
    expect(read()).toHaveLength(MAX_RPC_SUBSCRIPTION_FAULTS);
    for (const fixture of fixtures.slice(0, 3)) expect(fixture.release).toHaveBeenCalledTimes(1);
    clearRpcSubscriptionFaults();
    for (const fixture of fixtures) expect(fixture.release).toHaveBeenCalledTimes(1);
  });

  it("RPC-UI3: synchronous retry failure stays visible as attempt 2 without React seeing removal", () => {
    const connection = rpc();
    try {
      connection.channel.listen("onTick")(() => undefined);
      const { id } = read()[0]!;
      retryRpcSubscriptionFault(id, 1);
      expect(read().map((item) => [item.id, item.attempt])).toEqual([[id, 2]]);
      retryRpcSubscriptionFault(id, 1);
      dismissRpcSubscriptionFault(id, 1);
      expect(read()[0]!.attempt).toBe(2);
      connection.client.dispose();
      expect(read()).toEqual([]);
    } finally {
      connection.dispose();
    }
  });

  it("RPC-UI4: equal event names on different connections and arguments keep independent retry commands", () => {
    const first = rpc();
    const second = rpc();
    try {
      for (const connection of [first, second]) {
        connection.channel.listen("onTick", { workspace: "a" })(() => undefined);
        connection.channel.listen("onTick", { workspace: "b" })(() => undefined);
      }
      expect(new Set(read().map((item) => item.id)).size).toBe(4);
      for (const { id, attempt } of read()) retryRpcSubscriptionFault(id, attempt);
      expect(read().map((item) => item.attempt)).toEqual([2, 2, 2, 2]);
      first.dispose();
      expect(read()).toHaveLength(2);
      second.dispose();
      expect(read()).toEqual([]);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("RPC-UI5: closing releases only presentation; last business unsubscribe removes live faults", () => {
    const connection = rpc();
    try {
      const lease = connection.channel.listen("onTick")(() => undefined);
      const { id, attempt } = read()[0]!;
      dismissRpcSubscriptionFault(id, attempt);
      expect(read()).toEqual([]);
      // Closing the toast did not dispose the logical subscription or its retry capability.
      connection.channel
        .listen("onTick")(() => undefined)
        .dispose();
      expect(read()).toEqual([]);
      lease.dispose();
      const next = connection.channel.listen("onTick")(() => undefined);
      expect(read()).toHaveLength(1);
      next.dispose();
      expect(read()).toEqual([]);
    } finally {
      connection.dispose();
    }
  });
});

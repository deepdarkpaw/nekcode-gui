import { describe, expect, it } from "vitest";
import { buildSshRemoteHostKey, type RemoteTarget } from "@zcode/shared";
import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";
import type { ReconnectClock } from "@zcode/server/remote/reconnectStateMachine.js";
import {
  createReconnectingRemoteConnection,
  type RemoteReconnectControls,
} from "./reconnectingRemoteConnection.js";
import type {
  WindowRemoteConnectionCloseEvent,
  WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";

class FakeClock implements ReconnectClock {
  private now = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  async advance(delayMs: number): Promise<void> {
    this.now += delayMs;
    for (const [id, timer] of this.timers) {
      if (timer.at > this.now) continue;
      this.timers.delete(id);
      timer.callback();
    }
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  }
}

interface FakeHandle extends WindowRemoteConnectionHandle<string> {
  close(event?: Partial<WindowRemoteConnectionCloseEvent>): void;
  disposed: boolean;
}

function fakeHandle(services: string): FakeHandle {
  const listeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const handle: FakeHandle = {
    services,
    disposed: false,
    dispose: () => {
      handle.disposed = true;
    },
    onDidClose: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    close: (event) => {
      for (const listener of listeners) listener({ exitCode: 255, signal: null, ...event });
    },
  };
  return handle;
}

const target: RemoteTarget = { kind: "ssh", host: "build.example", port: 22, username: "dev" };

async function setup(connects: Array<() => Promise<FakeHandle>>) {
  const clock = new FakeClock();
  const events: RemoteConnectionStatusEvent[] = [];
  const adapters = new Map<string, RemoteReconnectControls>();
  let calls = 0;
  const connection = await createReconnectingRemoteConnection<string, never>({
    target,
    signal: new AbortController().signal,
    backoffSeconds: [1, 2],
    clock,
    connect: async () => {
      const next = connects[calls];
      calls += 1;
      if (!next) throw new Error("no more connections");
      return await next();
    },
    emit: (event) => events.push(event),
    attachReconnectAdapter: (connectionId, adapter) => {
      adapters.set(connectionId, adapter);
      return () => adapters.delete(connectionId);
    },
  });
  return { clock, events, adapters, connection, calls: () => calls };
}

describe("createReconnectingRemoteConnection", () => {
  it("drives the reconnect state machine from the real connection's close event", async () => {
    const first = fakeHandle("first");
    const second = fakeHandle("second");
    const { clock, events, adapters, connection } = await setup([
      async () => first,
      async () => second,
    ]);
    const connectionId = buildSshRemoteHostKey(target);
    expect(adapters.has(connectionId)).toBe(true);
    expect(connection.services).toBe("first");

    first.close({ error: "socket reset" });
    // 旧连接在退役链上异步释放；新连接只会在它释放之后建立。
    await clock.advance(0);
    expect(first.disposed).toBe(true);
    expect(() => connection.services).toThrow(/not connected/);
    expect(events.at(-1)).toMatchObject({ kind: "reconnecting", attempt: 1, nextDelayMs: 1000 });

    await clock.advance(1000);
    expect(connection.services).toBe("second");
    expect(events.at(-1)).toMatchObject({ kind: "connected", connectionId });
  });

  it("routes manual retry/cancel through the attached adapter and stops on dispose", async () => {
    const first = fakeHandle("first");
    const second = fakeHandle("second");
    const { clock, events, adapters, connection, calls } = await setup([
      async () => first,
      async () => second,
    ]);
    const adapter = adapters.get(buildSshRemoteHostKey(target));
    first.close();
    adapter?.cancelReconnect();
    expect(events.at(-1)).toMatchObject({ kind: "cancelled" });
    await clock.advance(5000);
    expect(calls()).toBe(1);

    adapter?.retryNow();
    await clock.advance(0);
    expect(connection.services).toBe("second");

    await connection.dispose();
    expect(second.disposed).toBe(true);
    expect(adapters.size).toBe(0);
  });
});

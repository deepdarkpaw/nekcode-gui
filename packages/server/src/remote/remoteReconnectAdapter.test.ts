import { describe, expect, it } from "vitest";
import {
  RemoteReconnectStatusAdapter,
  toRemoteConnectionStatusEvent,
} from "./remoteReconnectAdapter.js";
import type { ReconnectClock, RemoteReconnectState } from "./reconnectStateMachine.js";
import { RemoteReconnectStateMachine } from "./reconnectStateMachine.js";

class FakeClock implements ReconnectClock {
  now = 0;
  private nextId = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

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
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now);
    for (const [id, timer] of due) {
      this.timers.delete(id);
      timer.callback();
      await Promise.resolve();
    }
  }
}

describe("RemoteReconnectStatusAdapter", () => {
  it("RC-1: maps every reconnect state and emits the initial state", () => {
    const states: RemoteReconnectState[] = [
      { kind: "connected" },
      { kind: "disconnected", error: new Error("socket") },
      { kind: "reconnecting", attempt: 2, max: 5, nextDelayMs: 2000 },
      { kind: "failed", error: new Error("offline"), attempts: 5, max: 5 },
      { kind: "cancelled" },
    ];
    expect(states.map((state) => toRemoteConnectionStatusEvent("remote-1", state))).toEqual([
      { connectionId: "remote-1", kind: "connected" },
      { connectionId: "remote-1", kind: "disconnected" },
      { connectionId: "remote-1", kind: "reconnecting", attempt: 2, max: 5, nextDelayMs: 2000 },
      { connectionId: "remote-1", kind: "failed", message: "offline" },
      { connectionId: "remote-1", kind: "cancelled" },
    ]);
  });

  it("RC-1: suppresses duplicate states but keeps changed retry details", async () => {
    const clock = new FakeClock();
    const events: unknown[] = [];
    const machine = new RemoteReconnectStateMachine({
      backoffSeconds: [1, 2],
      clock,
      connect: async () => {
        throw new Error("offline");
      },
    });
    const adapter = new RemoteReconnectStatusAdapter({
      connectionId: "remote-1",
      machine,
      emit: (event) => events.push(event),
    });
    machine.markConnected();
    machine.markDisconnected();
    await clock.advance(1000);
    await clock.advance(2000);
    expect(events).toEqual([
      { connectionId: "remote-1", kind: "connected" },
      { connectionId: "remote-1", kind: "disconnected" },
      { connectionId: "remote-1", kind: "reconnecting", attempt: 1, max: 2, nextDelayMs: 1000 },
      { connectionId: "remote-1", kind: "reconnecting", attempt: 2, max: 2, nextDelayMs: 2000 },
      { connectionId: "remote-1", kind: "failed", message: "offline" },
    ]);
    adapter.dispose();
    machine.markConnected();
    expect(events).toHaveLength(5);
  });

  it("RC-2: delegates retry and cancel, and does nothing while connected", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const machine = new RemoteReconnectStateMachine({
      backoffSeconds: [1],
      clock,
      connect: async () => {
        calls += 1;
      },
    });
    const events: unknown[] = [];
    const adapter = new RemoteReconnectStatusAdapter({
      connectionId: "remote-1",
      machine,
      emit: (event) => events.push(event),
    });
    adapter.retryNow();
    await clock.advance(0);
    expect(calls).toBe(0);
    machine.markDisconnected();
    adapter.retryNow();
    await clock.advance(0);
    expect(calls).toBe(1);
    machine.markDisconnected();
    adapter.cancelReconnect();
    expect(machine.state).toEqual({ kind: "cancelled" });
    expect(events.at(-1)).toEqual({ connectionId: "remote-1", kind: "cancelled" });
  });
});

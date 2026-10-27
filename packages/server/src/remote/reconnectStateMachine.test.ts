import { describe, expect, it } from "vitest";
import {
  RemoteReconnectStateMachine,
  type ReconnectClock,
  type RemoteReconnectState,
} from "./reconnectStateMachine.js";

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

describe("RemoteReconnectStateMachine", () => {
  it("follows configured backoff and reaches connected after retry", async () => {
    const clock = new FakeClock();
    const states: RemoteReconnectState[] = [];
    let calls = 0;
    const machine = new RemoteReconnectStateMachine({
      backoffSeconds: [1, 2, 4],
      clock,
      connect: async () => {
        calls += 1;
        if (calls < 3) throw new Error(`failure-${calls}`);
      },
      onStateChange: (state) => states.push(state),
    });
    machine.markDisconnected(new Error("socket closed"));
    expect(states.map((state) => state.kind)).toEqual(["disconnected", "reconnecting"]);
    expect(machine.state).toMatchObject({ kind: "reconnecting", attempt: 1, nextDelayMs: 1000 });

    await clock.advance(999);
    expect(calls).toBe(0);
    await clock.advance(1);
    expect(calls).toBe(1);
    expect(machine.state).toMatchObject({ kind: "reconnecting", attempt: 2, nextDelayMs: 2000 });
    await clock.advance(2000);
    expect(calls).toBe(2);
    expect(machine.state).toMatchObject({ kind: "reconnecting", attempt: 3, nextDelayMs: 4000 });
    await clock.advance(4000);
    expect(calls).toBe(3);
    expect(machine.state).toEqual({ kind: "connected" });
  });

  it("fails after max attempts and supports immediate manual retry/cancel", async () => {
    const clock = new FakeClock();
    let calls = 0;
    const machine = new RemoteReconnectStateMachine({
      backoffSeconds: [1, 2],
      clock,
      connect: async () => {
        calls += 1;
        throw new Error("offline");
      },
    });
    machine.markDisconnected();
    await clock.advance(1000);
    await clock.advance(2000);
    expect(machine.state).toMatchObject({ kind: "failed", attempts: 2, max: 2 });
    machine.retryNow();
    expect(machine.state).toMatchObject({ kind: "reconnecting", attempt: 1, nextDelayMs: 0 });
    machine.cancel();
    await clock.advance(0);
    expect(machine.state).toEqual({ kind: "cancelled" });
    expect(calls).toBe(2);
  });
});

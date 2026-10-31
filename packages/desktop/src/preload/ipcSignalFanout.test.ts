import assert from "node:assert/strict";
import test from "node:test";
import { createIpcSignalFanout, type IpcSignalSource } from "./ipcSignalFanout.js";

class FakeIpcSignalSource implements IpcSignalSource {
  private readonly listeners = new Set<() => void>();
  onCount = 0;
  removeCount = 0;

  on(_channel: string, listener: () => void): void {
    this.onCount += 1;
    this.listeners.add(listener);
  }

  removeListener(_channel: string, listener: () => void): void {
    this.removeCount += 1;
    this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

test("settings signal fanout registers one native listener for N subscribers", () => {
  const source = new FakeIpcSignalSource();
  const fanout = createIpcSignalFanout(source, "zcode:settings-changed");
  const calls: number[] = [];
  const disposers = Array.from({ length: 16 }, (_, index) =>
    fanout.subscribe(() => calls.push(index)),
  );

  assert.equal(source.onCount, 1);
  assert.equal(source.listenerCount(), 1);
  source.emit();
  assert.equal(calls.length, 16);

  for (const dispose of disposers) dispose();
  assert.equal(source.removeCount, 1);
  assert.equal(source.listenerCount(), 0);
  assert.equal(fanout.subscriberCount(), 0);
});

test("releasing one settings subscriber does not detach the shared listener", () => {
  const source = new FakeIpcSignalSource();
  const fanout = createIpcSignalFanout(source, "zcode:settings-changed");
  const first = fanout.subscribe(() => undefined);
  const second = fanout.subscribe(() => undefined);

  first();
  first();
  assert.equal(source.listenerCount(), 1);
  assert.equal(fanout.subscriberCount(), 1);

  second();
  assert.equal(source.listenerCount(), 0);
  assert.equal(fanout.subscriberCount(), 0);
});

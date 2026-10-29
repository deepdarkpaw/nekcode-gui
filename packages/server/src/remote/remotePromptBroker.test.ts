import { describe, expect, it } from "vitest";
import { RemotePromptBroker, type RemotePromptClock } from "./remotePromptBroker.js";
import type { RemotePromptEvent } from "@zcode/shared/nek-protocol";

class FakeClock implements RemotePromptClock {
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

function createBroker(
  events: RemotePromptEvent[],
  options: Partial<ConstructorParameters<typeof RemotePromptBroker>[0]> = {},
) {
  return new RemotePromptBroker({
    connectionId: "connection-a",
    host: "example.test",
    username: "alice",
    emit: (event) => events.push(event),
    ...options,
  });
}

describe("RemotePromptBroker", () => {
  it("PB-1: emits an identified host-key request and maps an accepted answer", async () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { idFactory: () => "prompt-1" });
    const result = broker.confirmHostKey({
      host: "remote.test",
      port: 2222,
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:abc",
    });
    expect(events).toEqual([
      {
        id: "prompt-1",
        connectionId: "connection-a",
        kind: "host_key",
        host: "remote.test",
        port: 2222,
        keyType: "ssh-ed25519",
        fingerprint: "SHA256:abc",
      },
    ]);
    expect(broker.respondRemotePrompt("prompt-1", { accepted: true })).toBe(true);
    await expect(result).resolves.toBe(true);
  });

  it("PB-2: maps cancellation and mismatched answers to callback cancellation", async () => {
    const events: RemotePromptEvent[] = [];
    const warnings: string[] = [];
    const broker = createBroker(events, {
      idFactory: () => "prompt-2",
      onWarning: (message) => warnings.push(message),
    });
    const result = broker.confirmHostKey({
      host: "remote.test",
      port: 22,
      keyType: "rsa-sha2-512",
      fingerprint: "SHA256:abc",
    });
    expect(broker.respondRemotePrompt("prompt-2", { value: "wrong-kind" })).toBe(true);
    await expect(result).resolves.toBe(false);
    expect(warnings).toHaveLength(1);
    expect(events.at(-1)).toEqual({ id: "prompt-2", reason: "aborted" });

    const passphraseEvents: RemotePromptEvent[] = [];
    const passphraseBroker = createBroker(passphraseEvents, { idFactory: () => "passphrase-1" });
    const cancelled = passphraseBroker.askPassphrase("~/.ssh/id_ed25519");
    expect(passphraseEvents.at(0)).toMatchObject({
      kind: "passphrase",
      privateKeyPath: "~/.ssh/id_ed25519",
    });
    expect(passphraseBroker.respondRemotePrompt("passphrase-1", { cancelled: true })).toBe(true);
    await expect(cancelled).resolves.toBeUndefined();
  });

  it("PB-3: times out with a timeout cancellation event", async () => {
    const events: RemotePromptEvent[] = [];
    const clock = new FakeClock();
    const broker = createBroker(events, { clock, timeoutMs: 10, idFactory: () => "timeout-1" });
    const result = broker.askPassword();
    await clock.advance(9);
    expect(broker.hasPendingPrompt).toBe(true);
    await clock.advance(1);
    await expect(result).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({ id: "timeout-1", reason: "timeout" });
  });

  it("PB-4: supersedes the old prompt on one connection while other connections remain independent", async () => {
    const events: RemotePromptEvent[] = [];
    let id = 0;
    const broker = createBroker(events, { idFactory: () => `same-${++id}` });
    const first = broker.askPassword();
    const _second = broker.askPassphrase();
    await expect(first).resolves.toBeUndefined();
    expect(events).toContainEqual({ id: "same-1", reason: "superseded" });
    const secondEvent = events.find((event) => event.id === "same-2");
    expect(secondEvent).toMatchObject({ kind: "passphrase" });

    const otherEvents: RemotePromptEvent[] = [];
    const other = new RemotePromptBroker({
      connectionId: "connection-b",
      host: "other.test",
      username: "bob",
      emit: (event) => otherEvents.push(event),
      idFactory: () => "other-1",
    });
    const otherResult = other.askPassword();
    expect(otherEvents[0]).toMatchObject({ id: "other-1", kind: "password" });
    expect(other.respondRemotePrompt("other-1", { value: "secret" })).toBe(true);
    await expect(otherResult).resolves.toBe("secret");
    expect(broker.hasPendingPrompt).toBe(true);
  });

  it("PB-5: aborts the pending prompt and sends an aborted cancellation", async () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { idFactory: () => "abort-1" });
    const controller = new AbortController();
    const result = broker.askPassword(controller.signal);
    controller.abort();
    await expect(result).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({ id: "abort-1", reason: "aborted" });
  });

  it("PB-6: disconnect cancels the current prompt and immediately cancels later prompts", async () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { idFactory: () => "disconnect-1" });
    const result = broker.askPassword();
    broker.rendererDidDisconnect();
    await expect(result).resolves.toBeUndefined();
    expect(events.at(-1)).toEqual({ id: "disconnect-1", reason: "disconnected" });
    expect(await broker.askPassword()).toBeUndefined();
    expect(events).toHaveLength(2);
  });

  it("PB-7/PB-9: ignores unknown and duplicate answers", async () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { idFactory: () => "answer-1" });
    expect(broker.respondRemotePrompt("missing", { cancelled: true })).toBe(false);
    const result = broker.askPassword();
    expect(broker.respondRemotePrompt("answer-1", { value: "one" })).toBe(true);
    expect(broker.respondRemotePrompt("answer-1", { value: "two" })).toBe(false);
    await expect(result).resolves.toBe("one");
  });

  it("PB-8/RA-1: emits a host-key-changed notification without creating a response wait", () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { idFactory: () => "changed-1" });
    broker.notifyHostKeyChanged({
      host: "remote.test",
      port: 22,
      keyType: "ssh-ed25519",
      oldFingerprint: "SHA256:old",
      newFingerprint: "SHA256:new",
    });
    expect(events).toEqual([
      {
        id: "changed-1",
        connectionId: "connection-a",
        kind: "host_key_changed",
        host: "remote.test",
        port: 22,
        keyType: "ssh-ed25519",
        oldFingerprint: "SHA256:old",
        newFingerprint: "SHA256:new",
      },
    ]);
    expect(broker.hasPendingPrompt).toBe(false);
  });

  it("PB-3/RA-2: uses the configured timeout and reasoned cancellation shape", async () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { timeoutMs: 120_000, idFactory: () => "reason-1" });
    const result = broker.askPassword();
    broker.rendererDidDisconnect();
    await expect(result).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ id: "reason-1", reason: "disconnected" });
  });

  it("PB-2: password requests carry the configured username and host", async () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { idFactory: () => "password-1" });
    const result = broker.askPassword();
    expect(events[0]).toEqual({
      id: "password-1",
      connectionId: "connection-a",
      kind: "password",
      username: "alice",
      host: "example.test",
    });
    expect(broker.respondRemotePrompt("password-1", { value: "secret" })).toBe(true);
    await expect(result).resolves.toBe("secret");
  });

  it("PB-5: reconnecting the renderer allows a later prompt", async () => {
    const events: RemotePromptEvent[] = [];
    const broker = createBroker(events, { idFactory: () => "reconnected-1" });
    broker.rendererDidDisconnect();
    broker.rendererDidConnect();
    const result = broker.askPassword();
    expect(broker.respondRemotePrompt("reconnected-1", { cancelled: true })).toBe(true);
    await expect(result).resolves.toBeUndefined();
  });
});

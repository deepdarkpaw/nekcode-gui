import { afterEach, describe, expect, it } from "vitest";

import { buildSshRemoteHostKey, type RemoteTarget } from "@zcode/shared";
import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";
import {
  createDesktopRemoteReconnect,
  desktopRemoteInteraction,
} from "./desktopRemoteReconnect.js";

const target: RemoteTarget = { kind: "ssh", host: "build.example", port: 22, username: "dev" };
const physicalId = buildSshRemoteHostKey(target);

function fakeChild() {
  const posted: unknown[] = [];
  return { posted, postMessage: (message: unknown) => posted.push(message) };
}

describe("createDesktopRemoteReconnect", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("projects one physical SSH status onto every bound logical session", async () => {
    const statuses: RemoteConnectionStatusEvent[] = [];
    disposers.push(desktopRemoteInteraction.onRemoteConnectionStatus((e) => statuses.push(e)));
    const disconnected: string[] = [];
    const reattached: string[] = [];
    const reconnect = createDesktopRemoteReconnect({
      reattach: async (sessionId) => {
        reattached.push(sessionId);
      },
      disconnect: (sessionId) => disconnected.push(sessionId),
      onError: () => undefined,
    });
    const child = fakeChild();
    const other = fakeChild();
    disposers.push(reconnect.bind("session-a", target, child));
    disposers.push(reconnect.bind("session-b", target, child));

    const status = (event: RemoteConnectionStatusEvent) => ({
      type: "remote-connection-status",
      event,
    });
    expect(
      reconnect.receive(other, status({ connectionId: physicalId, kind: "disconnected" })),
    ).toBe(true);
    expect(disconnected).toEqual([]);

    reconnect.receive(child, status({ connectionId: physicalId, kind: "disconnected" }));
    expect(disconnected).toEqual(["session-a", "session-b"]);
    expect(statuses.filter((e) => e.kind === "disconnected").map((e) => e.connectionId)).toEqual([
      "session-a",
      "session-b",
    ]);

    reconnect.receive(child, status({ connectionId: physicalId, kind: "connected" }));
    await Promise.resolve();
    expect(reattached).toEqual(["session-a", "session-b"]);
    expect(reconnect.receive(child, { type: "something-else" })).toBe(false);
  });

  it("turns a renderer retry into a command for the host that owns the connection", async () => {
    const reconnect = createDesktopRemoteReconnect({
      reattach: async () => undefined,
      disconnect: () => undefined,
      onError: () => undefined,
    });
    const child = fakeChild();
    disposers.push(reconnect.bind("session-a", target, child));
    await desktopRemoteInteraction.retryNow("session-a");
    await desktopRemoteInteraction.cancelReconnect("session-a");
    expect(child.posted).toEqual([
      { type: "remote-reconnect-command", connectionId: physicalId, action: "retry" },
      { type: "remote-reconnect-command", connectionId: physicalId, action: "cancel" },
    ]);
  });

  it("reports a failed reattachment as a visible failed status", async () => {
    const statuses: RemoteConnectionStatusEvent[] = [];
    disposers.push(desktopRemoteInteraction.onRemoteConnectionStatus((e) => statuses.push(e)));
    const errors: unknown[] = [];
    const reconnect = createDesktopRemoteReconnect({
      reattach: async () => {
        throw new Error("window gone");
      },
      disconnect: () => undefined,
      onError: (_sessionId, error) => errors.push(error),
    });
    const child = fakeChild();
    disposers.push(reconnect.bind("session-a", target, child));
    reconnect.receive(child, {
      type: "remote-connection-status",
      event: { connectionId: physicalId, kind: "disconnected" },
    });
    reconnect.receive(child, {
      type: "remote-connection-status",
      event: { connectionId: physicalId, kind: "connected" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statuses.at(-1)).toEqual({
      connectionId: "session-a",
      kind: "failed",
      message: "window gone",
    });
    expect(errors).toHaveLength(1);
  });
});

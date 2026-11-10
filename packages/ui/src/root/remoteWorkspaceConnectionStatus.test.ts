import { describe, expect, it } from "vitest";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import { projectRemoteWorkspaceConnectionStatus } from "./remoteWorkspaceConnectionStatus.js";

const target = { kind: "ssh" as const, host: "example.test", username: "test", port: 22 };
const tabs = ["one", "two"].map((name) => ({
  id: name,
  kind: "workspace",
  label: name,
  workspacePath: `/project/${name}`,
  workspaceIdentity: `remote:${name}`,
  remoteSessionId: "connection",
  remoteTarget: target,
})) as WorkspaceTabState[];
const entries: RemoteWorkspaceSessionEntry[] = tabs.map((tab) => ({
  kind: "remote",
  workspacePath: tab.workspacePath,
  workspaceIdentity: tab.workspaceIdentity,
  target,
  lastOpenedAt: 1,
  lastConnectionStatus: "connected",
}));

describe("GU-1 upstream workspace connection surfaces", () => {
  it("projects reconnecting to all bound projects, regardless of the active tab", () => {
    const patch = projectRemoteWorkspaceConnectionStatus(
      { connectionId: "connection", kind: "reconnecting", attempt: 1, max: 5, nextDelayMs: 1000 },
      tabs,
      entries,
      "disconnected",
    );
    expect(patch?.reconnecting).toBe(true);
    expect([...patch!.keys]).toEqual(tabs.map(buildWorkspaceSessionKey));
    expect(patch?.entries).toBe(entries);
  });
  it("exposes the real failed message and clears it when the same connection recovers", () => {
    const failed = projectRemoteWorkspaceConnectionStatus(
      { connectionId: "connection", kind: "failed", message: "SSH handshake failed" },
      tabs,
      entries,
      "disconnected",
    )!;
    expect(failed.reconnecting).toBe(false);
    expect(
      failed.entries.every((entry) => entry.lastConnectionError === "SSH handshake failed"),
    ).toBe(true);
    const recovered = projectRemoteWorkspaceConnectionStatus(
      { connectionId: "connection", kind: "connected" },
      tabs,
      failed.entries,
      "disconnected",
    )!;
    expect(
      recovered.entries.every(
        (entry) =>
          entry.lastConnectionStatus === "connected" && entry.lastConnectionError === undefined,
      ),
    ).toBe(true);
  });
  it("cancelled is disconnected, unrelated or retired connections do not change project state", () => {
    const cancelled = projectRemoteWorkspaceConnectionStatus(
      { connectionId: "connection", kind: "cancelled" },
      tabs,
      entries,
      "disconnected",
    )!;
    expect(cancelled.entries[0]?.lastConnectionError).toBe("disconnected");
    expect(
      projectRemoteWorkspaceConnectionStatus(
        { connectionId: "retired", kind: "connected" },
        tabs,
        entries,
        "disconnected",
      ),
    ).toBeNull();
    expect(entries[0]?.lastConnectionStatus).toBe("connected");
  });
});

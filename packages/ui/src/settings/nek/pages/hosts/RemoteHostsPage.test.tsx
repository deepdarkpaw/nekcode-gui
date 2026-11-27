// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildRemoteWorkspaceSessionMutation } from "@/lib/remoteWorkspaceHistory.js";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { openHostSettings } from "../../api/hostSettingsIntent.js";
import { manualReloadStatus } from "../../api/manualHostReload.js";
import { RemoteHostsPage } from "./RemoteHostsPage.js";

const platform = vi.hoisted(() => ({
  listSSHConfigAliases: async () => [
    { alias: "dev-box", host: "10.0.0.5", username: "dev" },
    { alias: "build", host: "build.example", username: "ci", port: 2222 },
  ],
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => platform }));
installDomPolyfills();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("merges workspace status and opens only the project assigned to the card", async () => {
  const env = createNekTestEnv();
  const host = env.host.hosts[0]!;
  host.state = "disconnected";
  host.workspaceConnections = 2;
  const project = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/srv/project",
    target: host.target,
    touchOpenedAt: true,
    lastConnectionStatus: "connected",
  }).entry;
  const other = {
    ...project,
    workspacePath: "/srv/wrong-host",
    workspaceIdentity: "other",
    target: { kind: "ssh", host: "wrong", username: "dev" } as const,
  };
  const onOpen = vi.fn(async () => undefined);
  render(<RemoteHostsPage projects={[project, other]} onOpenProject={onOpen} />, {
    wrapper: env.wrapper,
  });
  const card = within(await screen.findByRole("region", { name: /dev-box/ }));
  expect(card.getByText(/工作区连接：2/)).toBeTruthy();
  expect(card.getByText(/设置连接：未连接/)).toBeTruthy();
  expect(screen.queryByText(other.workspacePath)).toBeNull();
  fireEvent.click(card.getByRole("button", { name: project.workspacePath }));
  expect(onOpen).toHaveBeenCalledWith(project.workspaceIdentity);

  const aliases = within(await screen.findByRole("region", { name: "可添加的 SSH 别名" }));
  expect(aliases.queryByText("dev-box")).toBeNull();
  fireEvent.click(aliases.getByRole("button", { name: "添加为主机" }));
  await waitFor(() =>
    expect(env.host.hosts.find(({ alias }) => alias === "build")?.target).toMatchObject({
      host: "build.example",
      sshConfigAlias: "build",
      port: 2222,
    }),
  );
});

it("opens the copy dialog for the addressed host, not the first or selected host", async () => {
  const env = createNekTestEnv();
  const target = env.host.hosts[1]!;
  const connect = vi.spyOn(env.host, "connectHost");
  openHostSettings({ target: target.target, action: "copy" });
  render(<RemoteHostsPage />, { wrapper: env.wrapper });
  expect(await screen.findByRole("dialog", { name: /gpu-server/ })).toBeTruthy();
  expect(connect).toHaveBeenCalledExactlyOnceWith(target.connectionId);
});

it("does not connect a copy intent whose saved id belongs to a different destination", async () => {
  const env = createNekTestEnv();
  const connect = vi.spyOn(env.host, "connectHost");
  openHostSettings({
    target: {
      kind: "ssh",
      host: "wrong",
      username: "root",
      savedHostId: env.host.hosts[1]!.connectionId,
    },
    action: "copy",
  });
  render(<RemoteHostsPage />, { wrapper: env.wrapper });
  expect(await screen.findByText(/无法唯一匹配/)).toBeTruthy();
  expect(connect).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps announced distinct from completion and does not suppress failures", () => {
  const result = { announced: true, reloaded: 0, deferred: 0, diagnostics: [], failures: [] };
  expect(manualReloadStatus(result)).toBe("reloadAnnounced");
  expect(
    manualReloadStatus({ ...result, failures: [{ sessionKey: "owner", message: "unreachable" }] }),
  ).toBe("reloadFailed");
});

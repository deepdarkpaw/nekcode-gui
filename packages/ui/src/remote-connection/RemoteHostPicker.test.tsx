// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createNekTestEnv } from "@/settings/nek/test/nekTestUtils.js";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
} from "@/lib/remoteWorkspaceHistory.js";
import { RemoteHostPicker, remoteHostChoices } from "./RemoteHostPicker.js";

afterEach(cleanup);
const ssh = { kind: "ssh", host: "box.test", username: "dev" } as const;
const history = (path: string) =>
  buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: path,
    target: { ...ssh, password: "secret" },
    touchOpenedAt: true,
    lastConnectionStatus: "connected",
  }).entry;

it("offers a saved SSH host without requiring a project or returning its password", async () => {
  const env = createNekTestEnv();
  const saved = await env.host.saveHost({ alias: "build-box", target: ssh });
  const onChoose = vi.fn();
  const onNew = vi.fn();
  render(
    <RemoteHostPicker
      history={[]}
      aliases={[]}
      aliasError=""
      loadingAliases={false}
      windows
      onChoose={onChoose}
      onNew={onNew}
    />,
    { wrapper: env.wrapper },
  );
  fireEvent.click(await screen.findByRole("button", { name: /build-box/ }));
  expect(onChoose).toHaveBeenCalledWith({
    label: "build-box",
    target: { ...ssh, savedHostId: saved.connectionId },
  });
  expect(onNew).not.toHaveBeenCalled();
  const target = onChoose.mock.calls[0]![0].target;
  const mutation = buildRemoteWorkspaceSessionMutation({
    remoteSessions: [],
    workspacePath: "/new",
    target,
    touchOpenedAt: true,
    lastConnectionStatus: "connected",
  });
  expect(mutation.credentialsToSave).toEqual([]);
  expect(
    createRemoteTargetFromSnapshot(mutation.entry.target, {
      password: null,
      privateKeyPassphrase: null,
    }),
  ).toMatchObject(target);
});

it("offers one recent connection per route rather than one per directory", () => {
  const a = history("/first");
  const b = history("/second");
  b.lastOpenedAt = a.lastOpenedAt + 1;
  const choices = remoteHostChoices(
    [],
    [a, b],
    [{ alias: "jump", host: ssh.host, username: ssh.username }],
  );
  expect(choices).toHaveLength(2);
  expect(choices[0]?.history).toBe(b.target);
  expect(choices[1]?.target).toMatchObject({ sshConfigAlias: "jump" });
});

it("shows a failed host read and can retry without connecting", async () => {
  const env = createNekTestEnv();
  const onChoose = vi.fn();
  vi.spyOn(env.host, "listHosts")
    .mockRejectedValueOnce(new Error("cannot read hosts"))
    .mockResolvedValue([]);
  render(
    <RemoteHostPicker
      history={[]}
      aliases={[]}
      aliasError=""
      loadingAliases={false}
      windows
      onChoose={onChoose}
      onNew={vi.fn()}
    />,
    { wrapper: env.wrapper },
  );
  fireEvent.click((await screen.findByRole("alert")).querySelector("button")!);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(onChoose).not.toHaveBeenCalled();
});

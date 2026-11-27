// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { INekWorkspaceConfigService, IServiceAccessor } from "@zcode/services";
import type { NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import { toast } from "@/components/ui/toast.js";
import { createNekTestEnv } from "@/settings/nek/test/nekTestUtils.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { MachineReloadNotifications } from "./MachineReloadNotifications.js";

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn(() => 1), dismissToast: vi.fn() }));
const success: NekSessionReloadOutcome = {
  reloaded: 1,
  deferred: 0,
  diagnostics: [],
  failures: [],
};
function owner() {
  let deliver: ((event: NekSessionReloadOutcome) => void) | undefined;
  const sub = { dispose: vi.fn() };
  const retry = vi.fn(async () => success);
  const service = {
    onDynamicDidReload: () => (listener: typeof deliver) => {
      deliver = listener;
      return sub;
    },
    callConfig: retry,
  } as unknown as INekWorkspaceConfigService;
  return {
    send: (result: Partial<NekSessionReloadOutcome>) => deliver?.({ ...success, ...result }),
    service,
    sub,
    retry,
  };
}
function attach(service: INekWorkspaceConfigService, sessionId = "connection") {
  useRemoteWorkspaceSessionStore.getState().registerSession({
    sessionId,
    target: {
      kind: "ssh",
      host: "remote",
      port: 22,
      username: "test",
      sshConfigAlias: "devbox",
      savedHostId: "saved-host",
    },
    services: { nekWorkspaceConfigService: service } as IServiceAccessor,
  });
}
afterEach(() => {
  cleanup();
  useRemoteWorkspaceSessionStore.getState().unregisterSession("connection");
  useRemoteWorkspaceSessionStore.getState().unregisterSession("second-project");
  vi.clearAllMocks();
});

it("observes the host without Settings, separates announced/applied, and fences reconnects", () => {
  const base = owner(),
    remote = owner(),
    next = owner();
  attach(remote.service);
  render(<MachineReloadNotifications local={base.service} />, {
    wrapper: createNekTestEnv().wrapper,
  });
  remote.send({ trigger: "write" });
  expect(toast).not.toHaveBeenCalled();
  remote.send({ trigger: "manual", announced: true, reloaded: 0 });
  expect(toast).not.toHaveBeenCalled();
  base.send({ trigger: "manual", reloaded: 2 });
  expect(toast).toHaveBeenLastCalledWith(
    expect.stringContaining("本机：已重载 2 个任务"),
    expect.anything(),
  );
  remote.send({ trigger: "write", reloaded: 0, deferred: 1 });
  expect(toast).toHaveBeenLastCalledWith(
    expect.stringContaining("devbox：已重载 0 个任务，1 个将在本轮结束后生效"),
    expect.anything(),
  );
  remote.send({
    diagnostics: [{ severity: "error", file: "mcp.json", message: "bad MCP config" }],
  });
  expect(toast).toHaveBeenLastCalledWith(
    expect.stringContaining("devbox 的配置重载失败：bad MCP config"),
    expect.objectContaining({ actionLabel: "重试" }),
  );
  const retry = vi.mocked(toast).mock.calls.at(-1)?.[1]?.onAction;
  act(() => attach(next.service));
  expect(remote.sub.dispose).toHaveBeenCalledOnce();
  retry?.();
  remote.send({ trigger: "manual", reloaded: 99 });
  expect(remote.retry).not.toHaveBeenCalled();
  expect(base.retry).not.toHaveBeenCalled();
  expect(next.retry).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledTimes(3);
});

it("keeps one listener for projects sharing an SSH host and transfers it when a project closes", () => {
  const first = owner(),
    second = owner();
  attach(first.service);
  attach(second.service, "second-project");
  render(<MachineReloadNotifications />, { wrapper: createNekTestEnv().wrapper });
  first.send({ trigger: "manual" });
  second.send({ trigger: "manual" });
  expect(toast).toHaveBeenCalledTimes(1);
  act(() => useRemoteWorkspaceSessionStore.getState().unregisterSession("connection"));
  first.send({ trigger: "manual" });
  second.send({ trigger: "manual" });
  expect(toast).toHaveBeenCalledTimes(2);
});

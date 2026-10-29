// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NekInstallResult, NekLocalDetection } from "@zcode/shared/nek-protocol";
import {
  createInitialNekStepState,
  isNekStepDone,
  statusFromDetection,
  useNekStepControllerWithApi,
} from "./onboardingNek.js";

const ready: NekLocalDetection = {
  status: "ready",
  version: "0.4.0",
  path: "/usr/local/bin/nek",
  protocolVersion: 1,
};

function apiFor(detection: NekLocalDetection) {
  return {
    detectLocalNek: vi.fn(async () => detection),
    installLocalNek: vi.fn(
      async (_options: { channel?: "stable" | "dev" }, _onLog: (line: string) => void) =>
        ({ ok: true, version: "0.4.0", cancelled: false }) as NekInstallResult,
    ),
    cancelLocalInstall: vi.fn(async () => undefined),
  };
}

describe("onboarding nek controller", () => {
  it.each([
    ["NK-2 ready", ready, "ready"],
    ["NK-2 not_installed", { status: "not_installed" }, "not_installed"],
    [
      "NK-2 incompatible",
      {
        status: "incompatible",
        version: "0.3.0",
        path: "/bin/nek",
        protocolVersion: 0,
        requiredProtocolVersion: 1,
      },
      "incompatible",
    ],
    ["NK-2 failed", { status: "failed", message: "ENOENT" }, "failed"],
  ] as const)("%s", (_name, detection, status) => {
    expect(statusFromDetection(detection)).toBe(status);
  });

  it("NK-7: ready is the only done state and installation does not advance the flow", () => {
    expect(isNekStepDone(createInitialNekStepState())).toBe(false);
    expect(isNekStepDone({ ...createInitialNekStepState(), status: "ready" })).toBe(true);
  });

  it("NK-5: logs retain only the final 2000 lines and expose truncation", async () => {
    const api = apiFor({ status: "not_installed" });
    api.installLocalNek.mockImplementation(async (_options, onLog) => {
      for (let index = 0; index < 2001; index += 1) onLog(`line ${index}`);
      return { ok: true, version: "0.4.0", cancelled: false };
    });
    const { result } = renderHook(() => useNekStepControllerWithApi(api));
    await waitFor(() => expect(result.current.state.status).toBe("not_installed"));
    await act(async () => result.current.install());
    expect(result.current.state.log).toHaveLength(2000);
    expect(result.current.state.log[0]).toBe("line 1");
    expect(result.current.state.logTruncated).toBe(true);
  });

  it("NK-1: initial detection runs once, recheck and install completion detect again", async () => {
    const api = apiFor({ status: "not_installed" });
    const { result } = renderHook(() => useNekStepControllerWithApi(api));
    await waitFor(() => expect(result.current.state.status).toBe("not_installed"));
    expect(api.detectLocalNek).toHaveBeenCalledTimes(1);
    await act(async () => result.current.detect());
    expect(api.detectLocalNek).toHaveBeenCalledTimes(2);
    await act(async () => result.current.install());
    expect(api.detectLocalNek).toHaveBeenCalledTimes(3);
  });

  it("NK-8: install failure retains message and manual command", async () => {
    const api = apiFor({ status: "not_installed" });
    api.installLocalNek.mockResolvedValue({
      ok: false,
      cancelled: false,
      message: "permission denied",
      manualCommand: "nek install --user",
    });
    const { result } = renderHook(() => useNekStepControllerWithApi(api));
    await waitFor(() => expect(result.current.state.status).toBe("not_installed"));
    await act(async () => result.current.install());
    expect(result.current.state).toMatchObject({
      status: "install_failed",
      message: "permission denied",
      manualCommand: "nek install --user",
    });
  });

  it("NK-10: channel defaults to stable, changes before install, and is locked while installing", async () => {
    const api = apiFor({ status: "not_installed" });
    let resolveInstall: ((value: NekInstallResult) => void) | undefined;
    api.installLocalNek.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const { result } = renderHook(() => useNekStepControllerWithApi(api));
    await waitFor(() => expect(result.current.state.status).toBe("not_installed"));
    expect(result.current.state.channel).toBe("stable");
    act(() => result.current.setChannel("dev"));
    expect(result.current.state.channel).toBe("dev");
    let running!: Promise<void>;
    act(() => {
      running = result.current.install();
    });
    await waitFor(() => expect(result.current.state.status).toBe("installing"));
    act(() => result.current.setChannel("stable"));
    expect(result.current.state.channel).toBe("dev");
    resolveInstall?.({ ok: true, version: "0.4.0", cancelled: false });
    await act(async () => running);
    expect(api.installLocalNek).toHaveBeenCalledWith({ channel: "dev" }, expect.any(Function));
  });

  it("NK-12: unmounting during installation does not cancel the host operation", async () => {
    const api = apiFor({ status: "not_installed" });
    let resolveInstall: ((value: NekInstallResult) => void) | undefined;
    api.installLocalNek.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const { result, unmount } = renderHook(() => useNekStepControllerWithApi(api));
    await waitFor(() => expect(result.current.state.status).toBe("not_installed"));
    let running!: Promise<void>;
    act(() => {
      running = result.current.install();
    });
    await waitFor(() => expect(result.current.state.status).toBe("installing"));
    unmount();
    expect(api.cancelLocalInstall).not.toHaveBeenCalled();
    resolveInstall?.({ ok: true, version: "0.4.0", cancelled: false });
    await running;
  });

  it("NK-6: cancellation waits for cancelled:true before entering install_cancelled", async () => {
    const api = apiFor({ status: "not_installed" });
    let resolveInstall: ((result: NekInstallResult) => void) | undefined;
    api.installLocalNek.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const { result } = renderHook(() => useNekStepControllerWithApi(api));
    await waitFor(() => expect(result.current.state.status).toBe("not_installed"));
    let running!: Promise<void>;
    act(() => {
      running = result.current.install();
    });
    await waitFor(() => expect(result.current.state.status).toBe("installing"));
    let cancelling!: Promise<void>;
    act(() => {
      cancelling = result.current.cancelInstall();
    });
    expect(result.current.state.status).toBe("installing");
    resolveInstall?.({
      ok: false,
      cancelled: true,
      message: "cancelled",
      manualCommand: "nek install",
    });
    await act(async () => {
      await cancelling;
      await running;
    });
    expect(api.cancelLocalInstall).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe("install_cancelled");
  });
});

// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createNekTestEnv, installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import { useOnboardingWorkspaceController } from "./onboardingWorkspaceController.js";

installDomPolyfills();

describe("onboarding workspace controller", () => {
  it("WS-1: local picker stores a local selection and null is a no-op", async () => {
    const env = createNekTestEnv();
    const { result } = renderHook(
      () => useOnboardingWorkspaceController({ onOpenRemote: vi.fn() }),
      { wrapper: env.wrapper },
    );
    await act(async () => result.current.actions.pickLocal.run());
    expect(result.current.view.selection).toEqual({
      kind: "local",
      path: "/home/me/projects/nekcode-gui",
    });
    env.host.selectedDirectory = null;
    await act(async () => result.current.actions.pickLocal.run());
    expect(result.current.view.selection).not.toBeNull();
  });

  it("WS-2/WS-3: remote selection is filled by the host and can be cleared", async () => {
    const env = createNekTestEnv();
    const onOpenRemote = vi.fn();
    const { result } = renderHook(() => useOnboardingWorkspaceController({ onOpenRemote }), {
      wrapper: env.wrapper,
    });
    await act(async () => result.current.actions.openRemote.run());
    expect(onOpenRemote).toHaveBeenCalledTimes(1);
    act(() =>
      result.current.setRemoteSelected({
        connectionId: "conn-1",
        path: "/remote/work",
        label: "dev-box",
      }),
    );
    await waitFor(() => expect(result.current.view.done).toBe(true));
    expect(result.current.view.selection).toEqual({
      kind: "remote",
      connectionId: "conn-1",
      path: "/remote/work",
      label: "dev-box",
    });
    await act(async () => result.current.actions.clearSelection.run());
    expect(result.current.view.selection).toBeNull();
  });
});

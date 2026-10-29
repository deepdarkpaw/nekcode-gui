// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createNekTestEnv, installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import { useNekOnboardingController } from "./useNekOnboardingController.js";

installDomPolyfills();

function props(overrides: Partial<Parameters<typeof useNekOnboardingController>[0]> = {}) {
  return {
    open: true,
    childDialogOpen: false,
    onComplete: vi.fn(),
    onClose: vi.fn(),
    onOpenLogin: vi.fn(),
    onOpenProviderForm: vi.fn(),
    onOpenRemote: vi.fn(),
    ...overrides,
  };
}

async function reachWorkspace(result: { current: ReturnType<typeof useNekOnboardingController> }) {
  await waitFor(() => expect(result.current.view.nek.status).toBe("ready"));
  await act(async () => result.current.actions.next.run());
  await waitFor(() => expect(result.current.view.currentStep).toBe("account"));
  await waitFor(() => expect(result.current.view.account.done).toBe(true));
  await act(async () => result.current.actions.next.run());
  await waitFor(() => expect(result.current.view.currentStep).toBe("workspace"));
}

describe("onboarding controller", () => {
  it("FL-4: every navigation action is disabled with a reason during installation", async () => {
    const env = createNekTestEnv({ latencyMs: 1 });
    env.host.localNek = { status: "not_installed" };
    const { result } = renderHook(() => useNekOnboardingController(props()), {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(result.current.view.nek.status).toBe("not_installed"));
    let install: Promise<void>;
    act(() => {
      install = result.current.actions.install.run();
    });
    await waitFor(() => expect(result.current.view.nek.status).toBe("installing"));
    for (const action of [
      result.current.actions.skip,
      result.current.actions.next,
      result.current.actions.close,
      result.current.actions.recheck,
      result.current.actions.jumpTo("nek"),
    ]) {
      if (action.visible) {
        expect(action.enabled).toBe(false);
        expect(action.disabledReason).toBeDefined();
      }
    }
    await act(async () => {
      await result.current.actions.cancelInstall.run();
      await install;
    });
  });

  it("NK-3/NK-4: install and update are the only visible primary actions for their statuses", async () => {
    const notInstalledEnv = createNekTestEnv();
    notInstalledEnv.host.localNek = { status: "not_installed" };
    const notInstalled = renderHook(() => useNekOnboardingController(props()), {
      wrapper: notInstalledEnv.wrapper,
    });
    await waitFor(() => expect(notInstalled.result.current.view.nek.status).toBe("not_installed"));
    expect(notInstalled.result.current.actions.install.visible).toBe(true);
    expect(notInstalled.result.current.actions.install.primary).toBe(true);
    expect(notInstalled.result.current.actions.update.visible).toBe(false);

    const incompatibleEnv = createNekTestEnv();
    incompatibleEnv.host.localNek = {
      status: "incompatible",
      version: "0.3.0",
      path: "/bin/nek",
      protocolVersion: 0,
      requiredProtocolVersion: 1,
    };
    const incompatible = renderHook(() => useNekOnboardingController(props()), {
      wrapper: incompatibleEnv.wrapper,
    });
    await waitFor(() => expect(incompatible.result.current.view.nek.status).toBe("incompatible"));
    expect(incompatible.result.current.actions.update.visible).toBe(true);
    expect(incompatible.result.current.actions.update.primary).toBe(true);
    expect(incompatible.result.current.actions.install.visible).toBe(false);
  });

  it("NK-9/NK-11: recheck is available after failure and next explains why nek is required", async () => {
    const env = createNekTestEnv();
    env.host.localNek = { status: "failed", message: "ENOENT" };
    const { result } = renderHook(() => useNekOnboardingController(props()), {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(result.current.view.nek.status).toBe("failed"));
    expect(result.current.actions.recheck.visible).toBe(true);
    expect(result.current.actions.recheck.enabled).toBe(true);
    expect(result.current.actions.next.enabled).toBe(false);
    expect(result.current.actions.next.disabledReason?.id).toBe("onboarding.nek.needNek");
  });

  it("WS-5: workspace next is disabled with the workspace reason until a selection exists", async () => {
    const env = createNekTestEnv();
    const { result } = renderHook(
      () => useNekOnboardingController(props({ startStep: "workspace" })),
      { wrapper: env.wrapper },
    );
    await waitFor(() => expect(result.current.view.currentStep).toBe("workspace"));
    expect(result.current.actions.next.enabled).toBe(false);
    expect(result.current.actions.next.disabledReason?.id).toBe(
      "onboarding.workspace.needWorkspace",
    );
  });

  it("FL-1/FL-5/WS-4: primary action changes by step and completion persists selection", async () => {
    const env = createNekTestEnv();
    const onComplete = vi.fn();
    const { result } = renderHook(() => useNekOnboardingController(props({ onComplete })), {
      wrapper: env.wrapper,
    });
    await reachWorkspace(result);
    expect(result.current.view.primaryActionId).toBe("pickLocal");
    await act(async () => result.current.actions.pickLocal.run());
    await waitFor(() => expect(result.current.view.primaryActionId).toBe("next"));
    await act(async () => result.current.actions.next.run());
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({
        kind: "local",
        path: "/home/me/projects/nekcode-gui",
      }),
    );
    expect(env.host.onboardingState.completedAt).toBeDefined();
  });

  it("FL-F1/FL-F2: opening and completing detection focus the current primary action", async () => {
    const env = createNekTestEnv();
    const { result } = renderHook(() => useNekOnboardingController(props()), {
      wrapper: env.wrapper,
    });
    expect(result.current.focus.target).toBe("install");
    await waitFor(() => expect(result.current.view.nek.status).toBe("ready"));
    await waitFor(() => expect(result.current.focus.target).toBe("next"));
    await act(async () => result.current.actions.next.run());
    await waitFor(() => expect(result.current.view.currentStep).toBe("account"));
    expect(result.current.focus.target).toBe(result.current.view.primaryActionId);
  });

  it("FL-F3: shared focus restore returns focus to the opener after a child closes", async () => {
    const { useFocusRestore } = await import("@/hooks/useFocusRestore.js");
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const { result, rerender } = renderHook(({ open }) => useFocusRestore(open), {
      initialProps: { open: true },
    });
    rerender({ open: false });
    expect(result.current.restoreFocus()).toBe(true);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("FL-7: state persistence failure stays open and is attached to the triggering handle", async () => {
    const env = createNekTestEnv();
    env.host.setOnboardingState = async () => {
      throw new Error("cannot persist");
    };
    const { result } = renderHook(() => useNekOnboardingController(props()), {
      wrapper: env.wrapper,
    });
    await waitFor(() => expect(result.current.view.nek.status).toBe("ready"));
    await act(async () => result.current.actions.close.run());
    await waitFor(() => expect(result.current.actions.close.error).toBe("cannot persist"));
    expect(result.current.view.open).toBe(true);
  });
});

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

  it("FL-1/FL-5/WS-4: primary action changes by step and completion persists selection", async () => {
    const env = createNekTestEnv();
    const onComplete = vi.fn();
    const { result } = renderHook(
      () => useNekOnboardingController(props({ onComplete })),
      { wrapper: env.wrapper },
    );
    await reachWorkspace(result);
    expect(result.current.view.primaryActionId).toBe("pickLocal");
    await act(async () => result.current.actions.pickLocal.run());
    await waitFor(() => expect(result.current.view.primaryActionId).toBe("next"));
    await act(async () => result.current.actions.next.run());
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith({
      kind: "local",
      path: "/home/me/projects/nekcode-gui",
    }));
    expect(env.host.onboardingState.completedAt).toBeDefined();
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

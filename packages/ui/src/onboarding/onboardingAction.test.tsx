// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createNekTestEnv, installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import { useOnboardingAction } from "./onboardingAction.js";

installDomPolyfills();

describe("onboarding action handles", () => {
  it("common §2.1: visible disabled actions always expose a disabled reason", () => {
    const env = createNekTestEnv();
    const { result } = renderHook(
      () =>
        useOnboardingAction({
          action: async () => undefined,
          enabled: false,
          disabledReason: { id: "onboarding.nek.installing" },
        }),
      { wrapper: env.wrapper },
    );
    expect(result.current.visible).toBe(true);
    expect(result.current.enabled).toBe(false);
    expect(result.current.disabledReason).toEqual({ id: "onboarding.nek.installing" });
  });

  it("common §2.2: two clicks while pending send only one request", async () => {
    const env = createNekTestEnv();
    let resolve: (() => void) | undefined;
    const action = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { result } = renderHook(() => useOnboardingAction({ action }), {
      wrapper: env.wrapper,
    });
    let first: Promise<void>;
    let second: Promise<void>;
    act(() => {
      first = result.current.run();
      second = result.current.run();
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBe(true);
    expect(result.current.enabled).toBe(false);
    resolve?.();
    await act(async () => {
      await first;
      await second;
    });
  });

  it("common §2.7: an enabled action invokes its observable side effect", async () => {
    const env = createNekTestEnv();
    const action = vi.fn(async () => undefined);
    const { result } = renderHook(() => useOnboardingAction({ action }), {
      wrapper: env.wrapper,
    });
    await act(async () => result.current.run());
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("common §2.3/§2.4: failure stays retryable and keeps the triggering handle error", async () => {
    const env = createNekTestEnv();
    const action = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useOnboardingAction({ action }), {
      wrapper: env.wrapper,
    });
    await act(async () => result.current.run());
    await waitFor(() => expect(result.current.error).toBe("temporary failure"));
    expect(result.current.enabled).toBe(true);
    await act(async () => result.current.run());
    expect(action).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeUndefined();
  });
});

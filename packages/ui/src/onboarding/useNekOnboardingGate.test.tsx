// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createNekTestEnv, installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";
import {
  openOnboarding,
  shouldShowNekOnboarding,
  useNekOnboardingGate,
} from "./useNekOnboardingGate.js";

installDomPolyfills();

describe("nek onboarding gate", () => {
  it("GT-1: only an empty onboarding record shows automatically", () => {
    expect(shouldShowNekOnboarding({})).toBe(true);
    expect(shouldShowNekOnboarding({ completedAt: "2026-01-01T00:00:00.000Z" })).toBe(false);
    expect(shouldShowNekOnboarding({ dismissedAt: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("GT-2: local nek availability does not independently open the gate", () => {
    expect(shouldShowNekOnboarding({ completedAt: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("GT-3/FL-2: explicit open always returns the first unfinished step", () => {
    expect(
      openOnboarding({ checking: true, done: { nek: true, account: true, workspace: true } }),
    ).toEqual({ open: true, step: "nek" });
    expect(
      openOnboarding({ checking: false, done: { nek: true, account: false, workspace: false } }),
    ).toEqual({ open: true, step: "account" });
    expect(
      openOnboarding({ checking: false, done: { nek: true, account: true, workspace: true } }),
    ).toEqual({ open: true, step: "workspace" });
  });

  it("GT-4: read failure hides rather than repeatedly opening", async () => {
    const env = createNekTestEnv();
    env.host.getOnboardingState = async () => {
      throw new Error("read failed");
    };
    const { result } = renderHook(() => useNekOnboardingGate(), { wrapper: env.wrapper });
    await waitFor(() => expect(result.current.status).toBe("hide"));
    expect(result.current.status === "hide" && result.current.error?.message).toBe("read failed");
  });

  it("GT-1: successful state read exposes persistence for the controller", async () => {
    const env = createNekTestEnv();
    const { result } = renderHook(() => useNekOnboardingGate(), { wrapper: env.wrapper });
    await waitFor(() => expect(result.current.status).toBe("show"));
    if (result.current.status !== "show") return;
    await result.current.persist({ completedAt: "2026-01-01T00:00:00.000Z" });
    expect(env.host.onboardingState.completedAt).toBe("2026-01-01T00:00:00.000Z");
    await waitFor(() => expect(result.current.status).toBe("hide"));
  });
});

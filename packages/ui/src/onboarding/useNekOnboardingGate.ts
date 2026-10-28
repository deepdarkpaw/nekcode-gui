import { useCallback, useEffect, useState } from "react";
import type { NekOnboardingState } from "@zcode/shared/nek-protocol";
import { useNekHostApi } from "@/settings/nek/api/NekSettingsContext.js";
import type { INekSettingsHostApi } from "@/settings/nek/api/hostApi.js";
import type { OnboardingStep } from "./onboardingFlow.js";

export interface OnboardingGateSnapshot {
  completedAt?: string;
  dismissedAt?: string;
}

export type NekOnboardingGateState =
  | { status: "loading"; retry: () => void }
  | {
      status: "show" | "hide";
      error?: Error;
      completedAt?: string;
      dismissedAt?: string;
      retry: () => void;
      persist: (patch: Partial<NekOnboardingState>) => Promise<void>;
    };

/** GT-1/GT-2：只看引导记录，不因本机 nek 不可用自动弹出。 */
export function shouldShowNekOnboarding(snapshot: OnboardingGateSnapshot): boolean {
  return snapshot.completedAt === undefined && snapshot.dismissedAt === undefined;
}

export async function readNekOnboardingGate(
  api: Pick<INekSettingsHostApi, "getOnboardingState">,
): Promise<OnboardingGateSnapshot> {
  return await api.getOnboardingState();
}

export interface OnboardingStartInput {
  checking: boolean;
  done: Readonly<Record<OnboardingStep, boolean>>;
}

/** GT-3/FL-2：显式打开时总是打开，起始步骤由第一个未完成步骤决定。 */
export function openOnboarding(input: OnboardingStartInput): { open: true; step: OnboardingStep } {
  if (input.checking || !input.done.nek) return { open: true, step: "nek" };
  if (!input.done.account) return { open: true, step: "account" };
  if (!input.done.workspace) return { open: true, step: "workspace" };
  return { open: true, step: "workspace" };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function useNekOnboardingGate(): NekOnboardingGateState {
  const api = useNekHostApi();
  const [refreshToken, setRefreshToken] = useState(0);
  const [snapshot, setSnapshot] = useState<OnboardingGateSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const retry = useCallback(() => {
    setError(null);
    setSnapshot(null);
    setRefreshToken((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void readNekOnboardingGate(api)
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(asError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [api, refreshToken]);

  const persist = useCallback(
    async (patch: Partial<NekOnboardingState>) => {
      await api.setOnboardingState(patch);
      setSnapshot((current) => (current ? { ...current, ...patch } : current));
    },
    [api],
  );

  if (!snapshot) {
    return error
      ? { status: "hide", error, retry, persist }
      : { status: "loading", retry };
  }
  return {
    status: shouldShowNekOnboarding(snapshot) ? "show" : "hide",
    ...snapshot,
    retry,
    persist,
  };
}

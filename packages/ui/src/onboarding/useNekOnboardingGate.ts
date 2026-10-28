import { useCallback, useEffect, useState } from "react";
import type { NekLocalStatus } from "@zcode/shared/nek-protocol";
import { useNekHostApi } from "@/settings/nek/api/NekSettingsContext.js";
import type { INekSettingsHostApi } from "@/settings/nek/api/hostApi.js";

export interface OnboardingGateSnapshot {
  onboardingComplete: boolean;
  localNek: NekLocalStatus;
}

export type NekOnboardingGateState =
  | { status: "loading"; retry: () => void }
  | {
      status: "ready";
      needsOnboarding: boolean;
      onboardingComplete: boolean;
      localNek: NekLocalStatus;
      markComplete: () => Promise<void>;
      retry: () => void;
    }
  | { status: "error"; error: Error; retry: () => void };

export function shouldShowNekOnboarding(snapshot: OnboardingGateSnapshot): boolean {
  return !snapshot.onboardingComplete || snapshot.localNek.state !== "ready";
}

export async function readNekOnboardingGate(
  api: Pick<INekSettingsHostApi, "readOnboardingComplete" | "detectLocalNek">,
): Promise<OnboardingGateSnapshot> {
  const [onboardingComplete, localNek] = await Promise.all([
    api.readOnboardingComplete(),
    api.detectLocalNek(),
  ]);
  return { onboardingComplete, localNek };
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
        if (!cancelled) {
          setSnapshot(next);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(asError(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, refreshToken]);

  const markComplete = useCallback(async () => {
    await api.writeOnboardingComplete(true);
    setSnapshot((current) => (current ? { ...current, onboardingComplete: true } : current));
  }, [api]);

  if (error) {
    return { status: "error", error, retry };
  }
  if (!snapshot) {
    return { status: "loading", retry };
  }
  return {
    status: "ready",
    needsOnboarding: shouldShowNekOnboarding(snapshot),
    onboardingComplete: snapshot.onboardingComplete,
    localNek: snapshot.localNek,
    markComplete,
    retry,
  };
}

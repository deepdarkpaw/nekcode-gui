import { useCallback, useRef, useState } from "react";
import type {
  NekInstallOptions,
  NekInstallResult,
  NekLocalStatus,
} from "@zcode/shared/nek-protocol";
import { useNekHostApi } from "@/settings/nek/api/NekSettingsContext.js";
import type { INekSettingsHostApi } from "@/settings/nek/api/hostApi.js";

export const MAX_ONBOARDING_LOG_LINES = 500;

export function isLocalNekReady(status: NekLocalStatus): boolean {
  return status.state === "ready";
}

export interface NekInstallationIdle {
  phase: "idle";
  logs: readonly string[];
}

export interface NekInstallationRunning {
  phase: "running";
  logs: readonly string[];
}

export interface NekInstallationSucceeded {
  phase: "succeeded";
  logs: readonly string[];
  result: Extract<NekInstallResult, { ok: true }>;
}

export interface NekInstallationFailed {
  phase: "failed";
  logs: readonly string[];
  result?: Extract<NekInstallResult, { ok: false }>;
  message: string;
}

export interface NekInstallationCancelled {
  phase: "cancelled";
  logs: readonly string[];
}

export type NekInstallationState =
  | NekInstallationIdle
  | NekInstallationRunning
  | NekInstallationSucceeded
  | NekInstallationFailed
  | NekInstallationCancelled;

const INITIAL_INSTALLATION_STATE: NekInstallationIdle = { phase: "idle", logs: [] };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useNekLocalInstallation(): {
  state: NekInstallationState;
  start: (options?: NekInstallOptions) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const api = useNekHostApi();
  return useNekLocalInstallationWithApi(api);
}

export function useNekLocalInstallationWithApi(
  api: Pick<INekSettingsHostApi, "installLocalNek" | "cancelLocalInstall">,
): {
  state: NekInstallationState;
  start: (options?: NekInstallOptions) => Promise<void>;
  cancel: () => Promise<void>;
} {
  const [state, setState] = useState<NekInstallationState>(INITIAL_INSTALLATION_STATE);
  const cancelRequested = useRef(false);

  const start = useCallback(
    async (options: NekInstallOptions = {}) => {
      if (state.phase === "running") {
        return;
      }
      cancelRequested.current = false;
      setState({ phase: "running", logs: [] });
      const appendLog = (line: string) =>
        setState((current) => ({
          ...current,
          logs: [...current.logs, line].slice(-MAX_ONBOARDING_LOG_LINES),
        }));
      try {
        const result = await api.installLocalNek(options, appendLog);
        if (cancelRequested.current) {
          setState((current) => ({ phase: "cancelled", logs: current.logs }));
          return;
        }
        if (result.ok) {
          setState((current) => ({ phase: "succeeded", logs: current.logs, result }));
          return;
        }
        setState((current) => ({
          phase: "failed",
          logs: current.logs,
          result,
          message: result.message,
        }));
      } catch (error) {
        if (cancelRequested.current) {
          setState((current) => ({ phase: "cancelled", logs: current.logs }));
          return;
        }
        setState((current) => ({
          phase: "failed",
          logs: current.logs,
          message: errorMessage(error),
        }));
      }
    },
    [api, state.phase],
  );

  const cancel = useCallback(async () => {
    if (state.phase !== "running") {
      return;
    }
    cancelRequested.current = true;
    await api.cancelLocalInstall();
    setState((current) => ({ phase: "cancelled", logs: current.logs }));
  }, [api, state.phase]);

  return { state, start, cancel };
}

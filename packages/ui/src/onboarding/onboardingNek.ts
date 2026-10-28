import { useCallback, useEffect, useRef, useState } from "react";
import type {
  NekInstallOptions,
  NekInstallResult,
  NekLocalDetection,
} from "@zcode/shared/nek-protocol";
import { useNekHostApi } from "@/settings/nek/api/NekSettingsContext.js";
import type { INekSettingsHostApi } from "@/settings/nek/api/hostApi.js";

export const MAX_ONBOARDING_LOG_LINES = 2000;

export type NekStepStatus =
  | "checking"
  | "ready"
  | "not_installed"
  | "incompatible"
  | "failed"
  | "installing"
  | "install_failed"
  | "install_cancelled";

export interface NekStepState {
  status: NekStepStatus;
  detection?: NekLocalDetection;
  log: readonly string[];
  logTruncated: boolean;
  channel: "stable" | "dev";
  message?: string;
  manualCommand?: string;
}

export function statusFromDetection(detection: NekLocalDetection): NekStepStatus {
  switch (detection.status) {
    case "ready":
      return "ready";
    case "not_installed":
      return "not_installed";
    case "incompatible":
      return "incompatible";
    case "failed":
      return "failed";
  }
}

export function isNekStepDone(state: NekStepState): boolean {
  return state.status === "ready";
}

export function createInitialNekStepState(): NekStepState {
  return {
    status: "checking",
    log: [],
    logTruncated: false,
    channel: "stable",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendLog(state: NekStepState, line: string): Pick<NekStepState, "log" | "logTruncated"> {
  const log = [...state.log, line];
  return {
    log: log.slice(-MAX_ONBOARDING_LOG_LINES),
    logTruncated: state.logTruncated || log.length > MAX_ONBOARDING_LOG_LINES,
  };
}

export interface NekStepController {
  state: NekStepState;
  detect: () => Promise<void>;
  install: () => Promise<void>;
  cancelInstall: () => Promise<void>;
  setChannel: (channel: "stable" | "dev") => void;
}

export function useNekStepController(options: { active?: boolean } = {}): NekStepController {
  return useNekStepControllerWithApi(useNekHostApi(), options);
}

export function useNekStepControllerWithApi(
  api: Pick<
    INekSettingsHostApi,
    "detectLocalNek" | "installLocalNek" | "cancelLocalInstall"
  >,
  options: { active?: boolean } = {},
): NekStepController {
  const [state, setState] = useState<NekStepState>(createInitialNekStepState);
  const installPromiseRef = useRef<Promise<void> | null>(null);
  const cancelRequestedRef = useRef(false);
  const hasCheckedRef = useRef(false);

  const detect = useCallback(async () => {
    if (state.status === "checking" || state.status === "installing") return;
    setState((current) => ({ ...current, status: "checking", message: undefined }));
    try {
      const detection = await api.detectLocalNek();
      hasCheckedRef.current = true;
      setState((current) => ({
        ...current,
        status: statusFromDetection(detection),
        detection,
        message: detection.status === "failed" ? detection.message : undefined,
        manualCommand: undefined,
      }));
    } catch (error) {
      hasCheckedRef.current = true;
      setState((current) => ({
        ...current,
        status: "failed",
        message: errorMessage(error),
        detection: undefined,
        manualCommand: undefined,
      }));
    }
  }, [api, state.status]);

  useEffect(() => {
    if (options.active === false || hasCheckedRef.current) return;
    hasCheckedRef.current = true;
    void (async () => {
      try {
        const detection = await api.detectLocalNek();
        setState((current) => ({
          ...current,
          status: statusFromDetection(detection),
          detection,
          message: detection.status === "failed" ? detection.message : undefined,
        }));
      } catch (error) {
        setState((current) => ({
          ...current,
          status: "failed",
          message: errorMessage(error),
        }));
      }
    })();
  }, [api, options.active]);

  const install = useCallback(async () => {
    if (installPromiseRef.current || (state.status !== "not_installed" && state.status !== "incompatible" && state.status !== "install_failed" && state.status !== "install_cancelled")) {
      return;
    }
    cancelRequestedRef.current = false;
    setState((current) => ({ ...current, status: "installing", log: [], logTruncated: false, message: undefined, manualCommand: undefined }));
    const run = (async () => {
      try {
        const result = await api.installLocalNek({ channel: state.channel }, (line) =>
          setState((current) => ({ ...current, ...appendLog(current, line) })),
        );
        if (result.cancelled || cancelRequestedRef.current) {
          setState((current) => ({ ...current, status: "install_cancelled" }));
          return;
        }
        if (!result.ok) {
          setState((current) => ({
            ...current,
            status: "install_failed",
            message: result.message,
            manualCommand: result.manualCommand,
          }));
          return;
        }
        const detection = await api.detectLocalNek();
        setState((current) => ({
          ...current,
          status: statusFromDetection(detection),
          detection,
          message: detection.status === "failed" ? detection.message : undefined,
        }));
      } catch (error) {
        if (cancelRequestedRef.current) {
          setState((current) => ({ ...current, status: "install_cancelled" }));
        } else {
          setState((current) => ({ ...current, status: "install_failed", message: errorMessage(error) }));
        }
      } finally {
        installPromiseRef.current = null;
      }
    })();
    installPromiseRef.current = run;
    await run;
  }, [api, state.channel, state.status]);

  const cancelInstall = useCallback(async () => {
    if (state.status !== "installing" || !installPromiseRef.current) return;
    cancelRequestedRef.current = true;
    await api.cancelLocalInstall();
    await installPromiseRef.current;
  }, [api, state.status]);

  const setChannel = useCallback((channel: "stable" | "dev") => {
    setState((current) => (current.status === "installing" ? current : { ...current, channel }));
  }, []);

  return { state, detect, install, cancelInstall, setChannel };
}

import { useEffect } from "react";
import type { NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import { dismissToast, toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toNekConfigApiError } from "./nekErrors.js";

export interface ReloadEndpoint {
  subscribe(listener: (result: NekSessionReloadOutcome) => void): () => void;
  retry(): Promise<NekSessionReloadOutcome>;
}

/** A retry belongs to the exact connection that reported the failure, never the current tab. */
export function useNekReloadNotifications(endpoint: ReloadEndpoint, host: string, key: string) {
  const { intl } = useZCodeIntl();
  useEffect(() => {
    let active = true;
    let retrying = false;
    let warningId: number | undefined;
    const t = (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id }, { host, ...values });
    const clearWarning = () => {
      if (warningId !== undefined) dismissToast(warningId);
      warningId = undefined;
    };
    const warn = (reason: string) => {
      clearWarning();
      warningId = toast(t("settings.nek.machineReload.failed", { reason }), {
        variant: "warning",
        durationMs: 0,
        dismissible: true,
        dismissLabel: t("common.close"),
        dedupeKey: `nek-reload-failure:${key}`,
        actionLabel: t("settings.nek.reload.retry"),
        onAction: () => {
          if (!active || retrying) return;
          retrying = true;
          void endpoint
            .retry()
            .then(
              (outcome) => report(outcome, true),
              (error: unknown) => {
                if (active) warn(toNekConfigApiError(error).message);
              },
            )
            .finally(() => {
              retrying = false;
            });
        },
      });
    };
    const report = (outcome: NekSessionReloadOutcome, retried = false) => {
      if (!active) return;
      const failure =
        outcome.failures[0] ?? outcome.diagnostics.find((d) => d.severity === "error");
      if (failure) return warn(failure.message);
      if (retried) clearWarning();
      const { reloaded, deferred } = outcome;
      const message =
        deferred > 0 || (outcome.trigger === "manual" && reloaded > 0)
          ? t("settings.nek.machineReload.counts", { reloaded, deferred })
          : retried
            ? t(
                outcome.announced
                  ? "settings.nek.machineReload.announced"
                  : "settings.nek.machineReload.counts",
                { reloaded, deferred },
              )
            : null;
      if (message) toast(message, { variant: "info", dedupeKey: `nek-reload-result:${key}` });
    };
    const stop = endpoint.subscribe(report);
    return () => {
      active = false;
      stop();
      clearWarning();
    };
  }, [endpoint, host, key, intl]);
}

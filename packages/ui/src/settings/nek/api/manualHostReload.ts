import type { NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import { toast } from "@/components/ui/toast.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";

type Intl = ReturnType<typeof useZCodeIntl>["intl"];

/** The main process can acknowledge a broadcast without knowing what its receivers did. */
export function manualReloadStatus(outcome: NekSessionReloadOutcome) {
  if (outcome.failures.length) return "reloadFailed";
  if ("announced" in outcome && outcome.announced === true) return "reloadAnnounced";
  if (outcome.reloaded || outcome.deferred) return "reloadCounts";
  return "reloadNone";
}

export function reportManualHostReload(intl: Intl, host: string, outcome: NekSessionReloadOutcome) {
  const status = manualReloadStatus(outcome);
  const text = intl.formatMessage(
    { id: `settings.nek.hostProjects.${status}` },
    {
      host,
      reloaded: outcome.reloaded,
      deferred: outcome.deferred,
      failed: outcome.failures.length,
      reason: outcome.failures[0]?.message ?? "",
    },
  );
  if (status === "reloadFailed") throw new Error(text);
  toast(text);
}

import { CopyIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import type { RefObject } from "react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { formatRemoteWorkspaceTargetSubtitle } from "@/lib/remoteWorkspaceHistory.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { openHostSettings } from "@/settings/nek/api/hostSettingsIntent.js";
import { reportManualHostReload } from "@/settings/nek/api/manualHostReload.js";

export function WorkspaceHostMenuItems({
  tab,
  busy,
}: {
  tab: WorkspaceTabState;
  busy: RefObject<boolean>;
}) {
  const { intl } = useZCodeIntl();
  const { services, rpcReady } = useWorkspaceServicesResolution(
    tab.workspacePath,
    tab.remoteSessionId,
    tab.workspaceIdentity,
    tab.remoteTarget,
  );
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  const remote = tab.remoteTarget;
  const host = remote
    ? formatRemoteWorkspaceTargetSubtitle(remote)
    : intl.formatMessage({ id: "settings.nek.resources.local" });
  const t = (id: string) => intl.formatMessage({ id: `settings.nek.hostProjects.${id}` });

  async function reload() {
    if (!rpcReady || busy.current) return;
    busy.current = true;
    try {
      // Omitting cwd applies to all running sessions of this owner, not just this row's path.
      const outcome = await services.nekWorkspaceConfigService.callConfig("reloadRunningSessions");
      // The calling owner replies here; only the other owners report via the broadcast listener.
      reportManualHostReload(intl, host, outcome);
    } catch (cause) {
      toast(getErrorMessage(cause), {
        variant: "warning",
        actionLabel: intl.formatMessage({ id: "common.retry" }),
        onAction: () => void reload(),
      });
    } finally {
      busy.current = false;
    }
  }

  return (
    <>
      <DropdownMenuItem
        onSelect={() => {
          if (!rpcReady) {
            toast(t("reloadDisconnected"), { variant: "warning" });
            return;
          }
          void reload();
        }}
      >
        <RefreshCwIcon aria-hidden="true" />
        {t("reloadConfig")}
      </DropdownMenuItem>
      {remote && openSettingsTab ? (
        <>
          <DropdownMenuItem
            onSelect={() =>
              openHostSettings({ target: remote, action: "settings" }, openSettingsTab)
            }
          >
            <ServerIcon aria-hidden="true" />
            {t("hostSettings")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => openHostSettings({ target: remote, action: "copy" }, openSettingsTab)}
          >
            <CopyIcon aria-hidden="true" />
            {t("copyFromLocal")}
          </DropdownMenuItem>
        </>
      ) : null}
      <DropdownMenuSeparator />
    </>
  );
}

import { useMemo } from "react";
import type { INekWorkspaceConfigService } from "@zcode/services";
import { buildSshConnectionKey } from "@zcode/shared";
import type { NekConfigTarget } from "@zcode/shared/nek-protocol";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceTargetSubtitle } from "@/lib/remoteWorkspaceHistory.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  useNekConfigApi,
  useNekTarget,
  targetKeyOf,
} from "@/settings/nek/api/NekSettingsContext.js";
import {
  type ReloadEndpoint,
  useNekReloadNotifications,
} from "@/settings/nek/api/useNekReloadNotifications.js";

/** Machine-level write/transport errors come from the settings writer, not the selected settings page. */
function SettingsListener({ connectionId, label }: { connectionId?: string; label: string }) {
  const api = useNekConfigApi();
  const target = useMemo<NekConfigTarget>(
    () => (connectionId === undefined ? { kind: "local" } : { kind: "remote", connectionId }),
    [connectionId],
  );
  const endpoint = useMemo<ReloadEndpoint>(
    () => ({
      subscribe: (listener) => api.onReloadResult(target, listener),
      retry: () => api.reloadRunningSessions(target),
    }),
    [api, target],
  );
  useNekReloadNotifications(endpoint, label, `settings:${targetKeyOf(target)}`);
  return null;
}

function OwnerListener({
  service,
  label,
  owner,
}: {
  service: INekWorkspaceConfigService;
  label: string;
  owner: string;
}) {
  const endpoint = useMemo<ReloadEndpoint>(
    () => ({
      subscribe: (listener) => {
        const sub = service.onDynamicDidReload()(listener);
        return () => sub.dispose();
      },
      retry: () => service.callConfig("reloadRunningSessions"),
    }),
    [service],
  );
  useNekReloadNotifications(endpoint, label, owner);
  return null;
}

/** Keep observing actual session owners even when the user closes Settings or switches machines. */
export function MachineReloadNotifications({ local }: { local?: INekWorkspaceConfigService }) {
  const { intl } = useZCodeIntl();
  const { targets } = useNekTarget();
  const sessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const seen = new Set([local]);
  const seenHostRoutes = new Set<string>();
  return (
    <>
      {targets.list
        .filter((info) => info.connected)
        .map(({ target, label }) => (
          <SettingsListener
            key={targetKeyOf(target)}
            label={label}
            connectionId={target.kind === "remote" ? target.connectionId : undefined}
          />
        ))}
      {local && (
        <OwnerListener
          service={local}
          label={intl.formatMessage({ id: "settings.nek.machineReload.local" })}
          owner="local"
        />
      )}
      {Object.values(sessions).map(({ sessionId, services, target }) => {
        const service = services.nekWorkspaceConfigService;
        if (!service || seen.has(service)) return null;
        // Each project has its own renderer port, but saved SSH projects on the same
        // connection share a gui-server. One listener is enough until that port retires.
        if (target?.kind === "ssh" && target.savedHostId) {
          const route = JSON.stringify([target.savedHostId, buildSshConnectionKey(target)]);
          if (seenHostRoutes.has(route)) return null;
          seenHostRoutes.add(route);
        }
        seen.add(service);
        const label =
          target?.kind === "ssh" && target.sshConfigAlias
            ? target.sshConfigAlias
            : target
              ? formatRemoteWorkspaceTargetSubtitle(target)
              : intl.formatMessage({ id: "settings.nek.machineReload.remote" });
        return (
          <OwnerListener
            key={sessionId}
            service={service}
            label={label}
            owner={`remote:${sessionId}`}
          />
        );
      })}
    </>
  );
}

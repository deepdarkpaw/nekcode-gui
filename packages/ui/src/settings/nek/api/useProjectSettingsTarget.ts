import { useEffect, useRef, useState } from "react";
import { matchSavedRemoteHost, type RemoteTarget } from "@zcode/shared";
import type { NekConfigTarget, NekConfigTargetInfo } from "@zcode/shared/nek-protocol";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceTargetSubtitle } from "@/lib/remoteWorkspaceHistory.js";
import type { SettingsWorkspaceBinding } from "../NekSettingsSection.js";
import { LOCAL_TARGET, sameTarget, type NekSettingsApis } from "./NekSettingsContext.js";
import { toNekConfigApiError } from "./nekErrors.js";
import { useSavedHosts } from "./useSavedHosts.js";

export function useProjectSettingsTarget({
  apis,
  workspace,
  remote,
  isRemote,
  selected,
  scoped,
  configPage,
}: {
  apis: NekSettingsApis;
  workspace?: SettingsWorkspaceBinding;
  remote?: RemoteTarget;
  isRemote: boolean;
  selected?: NekConfigTarget;
  scoped: boolean;
  configPage: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { hosts, error, reload } = useSavedHosts(apis.host, isRemote && !!remote && configPage);
  const saved = matchSavedRemoteHost(remote, error ? [] : (hosts ?? []));
  const identifying = isRemote && !!remote && hosts === null && !error;
  const unmatched = isRemote && !!remote && hosts !== null && !saved && !error;
  const unresolved =
    unmatched &&
    ((remote?.kind === "ssh" && !!remote.savedHostId) ||
      hosts.some((host) => !!matchSavedRemoteHost(remote, [host])));
  const unsaved = unmatched && !unresolved;
  const projectTarget: NekConfigTarget = !isRemote
    ? LOCAL_TARGET
    : saved
      ? { kind: "remote", connectionId: saved.connectionId }
      : { kind: "remote", connectionId: "project-workspace" };
  const target = selected ?? projectTarget;
  const onProjectHost = sameTarget(target, projectTarget);
  const projectWorkspace = onProjectHost && scoped && !apis.isMock ? workspace?.info : undefined;
  const viaWorkspace =
    !!projectWorkspace &&
    (!saved || projectWorkspace.connected) &&
    (!isRemote || projectWorkspace.target.kind === "remote");
  const workspaceInfo: NekConfigTargetInfo | undefined =
    isRemote && !saved
      ? {
          target: projectTarget,
          label: remote
            ? formatRemoteWorkspaceTargetSubtitle(remote)
            : intl.formatMessage({ id: "settings.nek.hostProjects.unknownHost" }),
          hostname: remote?.kind === "ssh" ? remote.host : "",
          connected: viaWorkspace && !identifying && !error && projectWorkspace?.connected === true,
          nek: { state: "unknown" },
        }
      : undefined;
  const targetInfo = onProjectHost
    ? viaWorkspace && projectWorkspace && !workspaceInfo
      ? {
          ...projectWorkspace,
          target,
          label: saved?.alias ?? projectWorkspace.label,
          nek: saved?.nek ?? projectWorkspace.nek,
        }
      : workspaceInfo
    : undefined;

  const connectId =
    configPage && onProjectHost && !selected && !viaWorkspace && saved?.state === "disconnected"
      ? saved.connectionId
      : undefined;
  const attempted = useRef<string | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  useEffect(() => {
    if (!connectId || attempted.current === connectId) return;
    attempted.current = connectId;
    setConnecting(true);
    void apis.host
      .connectHost(connectId)
      .catch((cause) => {
        setConnectError(toNekConfigApiError(cause).message);
      })
      .finally(() => setConnecting(false));
  }, [apis.host, connectId]);

  return {
    target,
    projectTarget,
    targetInfo,
    workspaceInfo,
    onProjectHost,
    viaWorkspace,
    fixedTarget: !!workspaceInfo && onProjectHost,
    unsaved,
    unresolved,
    identifying,
    error,
    reload,
    connecting: onProjectHost && connecting,
    connectError: onProjectHost && saved?.state !== "connected" ? connectError : null,
  };
}

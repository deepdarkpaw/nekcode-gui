import { useMemo } from "react";
import { createOpenInEditorRemoteTarget } from "@zcode/shared";
import type { NekConfigTarget } from "@zcode/shared/nek-protocol";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { SettingsWorkspaceBinding } from "../NekSettingsSection.js";
import { LOCAL_TARGET } from "./NekSettingsContext.js";

export function useSettingsWorkspaceBinding(
  cwd: string | null | undefined,
  tab?: WorkspaceTabState,
): SettingsWorkspaceBinding | undefined {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { services, isRemoteTarget, remoteSessionId, rpcReady } = useWorkspaceServicesResolution(
    cwd,
    tab?.remoteSessionId,
    tab?.workspaceIdentity,
    tab?.remoteTarget,
  );
  const { nekWorkspaceConfigService } = services;
  return useMemo(() => {
    if (!cwd) return { service: nekWorkspaceConfigService };
    const target: NekConfigTarget = isRemoteTarget
      ? { kind: "remote", connectionId: remoteSessionId ?? tab?.workspaceIdentity ?? cwd }
      : LOCAL_TARGET;
    const editorTarget = tab?.remoteTarget && createOpenInEditorRemoteTarget(tab.remoteTarget);
    const editorId =
      editorTarget?.kind === "ssh" || editorTarget?.kind === "wsl" ? "vscode" : undefined;
    return {
      service: nekWorkspaceConfigService,
      info: {
        target,
        label: isRemoteTarget
          ? (tab?.label ?? cwd)
          : intl.formatMessage({ id: "settings.nek.resources.local" }),
        hostname: isRemoteTarget && tab?.remoteTarget?.kind === "ssh" ? tab.remoteTarget.host : "",
        connected: rpcReady,
        nek: { state: "unknown" },
      },
      openRemotePath:
        editorTarget && editorId
          ? async (path, pathKind) => {
              const result = await platform.openInEditor(editorId, path, {
                remoteTarget: editorTarget,
                workspaceIdentity: tab?.workspaceIdentity,
                pathKind,
              });
              if (!result.success)
                throw new Error(
                  result.error ?? intl.formatMessage({ id: "settings.nek.resources.openFailed" }),
                );
            }
          : undefined,
    };
  }, [
    cwd,
    intl,
    isRemoteTarget,
    nekWorkspaceConfigService,
    platform,
    remoteSessionId,
    rpcReady,
    tab,
  ]);
}

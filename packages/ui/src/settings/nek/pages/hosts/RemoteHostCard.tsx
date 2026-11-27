import { useEffect, useRef, useState } from "react";
import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FingerprintIcon,
  PencilIcon,
  PlugIcon,
  RefreshCwIcon,
  ServerIcon,
  Unplug,
} from "lucide-react";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { formatRemoteWorkspaceTargetSubtitle } from "@/lib/remoteWorkspaceHistory.js";
import { AsyncButton } from "@/components/ui/async-button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NekRemoteHost } from "../../api/hostApi.js";
import { useNekSettingsContext } from "../../api/NekSettingsContext.js";
import { reportManualHostReload } from "../../api/manualHostReload.js";
import { HostProjectList } from "./HostProjectList.js";

export type HostDialog = "edit" | "install" | "fingerprints" | "copy" | "delete";

const STATE_DOT: Record<NekRemoteHost["state"], string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  disconnected: "bg-foreground-subtlest",
  failed: "bg-destructive",
};

export function RemoteHostCard({
  host,
  onOpen,
  onCopy,
  projects,
  onOpenProject,
  highlighted,
}: {
  host: NekRemoteHost;
  onOpen: (kind: HostDialog) => void;
  onCopy: () => Promise<void>;
  projects?: RemoteWorkspaceSessionEntry[];
  onOpenProject?: (key: string) => Promise<void>;
  highlighted?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const { host: api, config, refreshTargets } = useNekSettingsContext();
  const [testResult, setTestResult] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);
  const settingsConnected = host.state === "connected";
  const connecting = host.state === "connecting";
  const workspaceConnections = host.workspaceConnections ?? 0;
  const state = workspaceConnections > 0 ? "connected" : host.state;
  const nekText =
    host.nek.state === "ready"
      ? `nek ${host.nek.version}`
      : t(`settings.nek.hosts.nek.${host.nek.state}`, {
          version: "version" in host.nek ? host.nek.version : "",
        });
  const target = { kind: "remote", connectionId: host.connectionId } as const;
  async function ensureConnected() {
    if (!settingsConnected) {
      await api.connectHost(host.connectionId);
      await refreshTargets();
    }
  }
  return (
    <section
      ref={ref}
      aria-labelledby={`nek-host-${host.connectionId}`}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4",
        highlighted ? "border-brand/50" : "border-card-border",
      )}
    >
      <header className="flex items-start gap-3">
        <ServerIcon className="mt-0.5 size-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3
            id={`nek-host-${host.connectionId}`}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-base font-medium"
          >
            <span className="break-words">{host.alias}</span>
            <span className="flex items-center gap-1 text-ui-sm font-normal text-foreground-subtle">
              <span aria-hidden="true" className={cn("size-2 rounded-full", STATE_DOT[state])} />
              {t(`settings.nek.hosts.state.${state}`)}
            </span>
          </h3>
          <p className="break-words font-mono text-ui-sm text-foreground-subtle">
            {formatRemoteWorkspaceTargetSubtitle(host.target)}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {t(`settings.nek.hosts.auth.${host.authMethod}`)} · {nekText}
            {host.fingerprints[0] ? (
              <span className="ml-2 font-mono text-ui-xs">
                {host.fingerprints[0].fingerprint.slice(0, 22)}…
              </span>
            ) : null}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {t("settings.nek.hostProjects.workspaceConnections", { count: workspaceConnections })}
            {" · "}
            {t("settings.nek.hostProjects.settingsConnection", {
              state: t(`settings.nek.hosts.state.${host.state}`),
            })}
          </p>
          {host.error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {host.error}
            </p>
          ) : null}
          {testResult ? (
            <p role="status" className="text-ui-sm text-success">
              {testResult}
            </p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t("settings.nek.hosts.more")}>
              <EllipsisIcon />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onOpen("edit")}>
              <PencilIcon aria-hidden="true" />
              {t("settings.nek.hosts.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen("fingerprints")}>
              <FingerprintIcon aria-hidden="true" />
              {t("settings.nek.hosts.fingerprints")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpen("install")}>
              <DownloadIcon aria-hidden="true" />
              {t(
                host.nek.state === "ready" || host.nek.state === "incompatible"
                  ? "settings.nek.hosts.updateNek"
                  : "settings.nek.hosts.installNek",
              )}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => onOpen("delete")}>
              {t("settings.nek.hosts.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <AsyncButton
          variant="outline"
          size="sm"
          icon={settingsConnected ? <Unplug /> : <PlugIcon />}
          successFeedback="none"
          disabled={connecting}
          disabledReason={t("settings.nek.hosts.state.connecting")}
          onClick={async () => {
            if (settingsConnected) await api.disconnectHost(host.connectionId);
            else await api.connectHost(host.connectionId);
            await refreshTargets();
          }}
        >
          {t(
            settingsConnected
              ? "settings.nek.hostProjects.disconnectSettings"
              : "settings.nek.hostProjects.connectSettings",
          )}
        </AsyncButton>
        <AsyncButton
          variant="outline"
          size="sm"
          onClick={async () => {
            setTestResult(null);
            const result = await api.testHost(host.connectionId);
            if (!result.ok) throw new Error(result.message);
            setTestResult(
              t("settings.nek.hosts.testOk", {
                ms: result.latencyMs,
                fingerprint: result.fingerprint,
              }),
            );
          }}
        >
          {t("settings.nek.hosts.test")}
        </AsyncButton>
        <AsyncButton
          variant="outline"
          size="sm"
          icon={<RefreshCwIcon />}
          successFeedback="none"
          onClick={async () => {
            await ensureConnected();
            reportManualHostReload(intl, host.alias, await config.reloadRunningSessions(target));
          }}
        >
          {t("settings.nek.hostProjects.reloadHost")}
        </AsyncButton>
        <AsyncButton
          variant="outline"
          size="sm"
          icon={<CopyIcon />}
          successFeedback="none"
          onClick={onCopy}
        >
          {t("settings.nek.hosts.copyFromLocal")}
        </AsyncButton>
      </div>
      {onOpenProject ? <HostProjectList projects={projects} onOpen={onOpenProject} /> : null}
    </section>
  );
}

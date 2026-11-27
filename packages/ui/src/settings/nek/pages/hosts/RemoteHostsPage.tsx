import { useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon, ServerIcon } from "lucide-react";
import {
  matchSavedRemoteHost,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type SSHConfigAliasOption,
} from "@zcode/shared";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import type { NekRemoteHost } from "../../api/hostApi.js";
import {
  consumeHostSettingsIntent,
  type HostSettingsIntent,
} from "../../api/hostSettingsIntent.js";
import { useNekSettingsContext } from "../../api/NekSettingsContext.js";
import { useSavedHosts } from "../../api/useSavedHosts.js";
import { NekEmptyState } from "../../components/DocumentStatus.js";
import { NekConfirmDialog } from "../../components/NekConfirmDialog.js";
import { NekPageFrame } from "../../components/NekPageFrame.js";
import { CopyToHostDialog } from "./CopyToHostDialog.js";
import { HostEditDialog } from "./HostEditDialog.js";
import { FingerprintsDialog, InstallNekDialog } from "./HostDialogs.js";
import { groupHostProjects } from "./HostProjectList.js";
import { RemoteHostCard, type HostDialog } from "./RemoteHostCard.js";
import { SshAliasList } from "./SshAliasList.js";

type Dialog =
  | { kind: HostDialog; host: NekRemoteHost }
  | { kind: "add"; target?: RemoteTarget; alias?: SSHConfigAliasOption };
const NO_PROJECTS: RemoteWorkspaceSessionEntry[] = [];

export function RemoteHostsPage({
  isWindowsDesktop = false,
  projects = NO_PROJECTS,
  onOpenProject,
}: {
  isWindowsDesktop?: boolean;
  projects?: RemoteWorkspaceSessionEntry[];
  onOpenProject?: (workspaceKey: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const { host: api, refreshTargets } = useNekSettingsContext();
  const { hosts, error, reload } = useSavedHosts(api, true, true);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [intent, setIntent] = useState<HostSettingsIntent>();
  const [directCopyStatus, setDirectCopyStatus] = useState<"loading" | string | null>(null);
  const handled = useRef(false);
  const projectGroups = useMemo(() => groupHostProjects(hosts ?? [], projects), [hosts, projects]);
  const focusedHost = hosts && intent && matchSavedRemoteHost(intent.target, hosts);
  const focusedHostId = focusedHost?.connectionId;
  const unresolved =
    !!intent &&
    !!hosts &&
    !focusedHost &&
    ((intent.target.kind === "ssh" && !!intent.target.savedHostId) ||
      hosts.some((host) => !!matchSavedRemoteHost(intent.target, [host])));
  const close = () => setDialog(null);
  const snapshot = dialog && dialog.kind !== "add" ? dialog.host : undefined;
  const current =
    snapshot && hosts?.find(({ connectionId }) => connectionId === snapshot.connectionId);

  useEffect(() => {
    const pending = consumeHostSettingsIntent();
    if (pending) setIntent(pending);
  }, []);

  useEffect(() => {
    if (!intent || !hosts || error || unresolved || handled.current) return;
    handled.current = true;
    if (!focusedHostId) setDialog({ kind: "add", target: intent.target });
  }, [intent, hosts, error, unresolved, focusedHostId]);

  async function openCopy(host: NekRemoteHost, expected?: RemoteTarget) {
    if (host.state !== "connected") await api.connectHost(host.connectionId);
    const latest = await api.listHosts();
    const currentHost = latest.find(({ connectionId }) => connectionId === host.connectionId);
    if (!currentHost || (expected && matchSavedRemoteHost(expected, latest) !== currentHost)) {
      throw new Error(t("settings.nek.hostProjects.unresolved"));
    }
    if (currentHost.state !== "connected" || currentHost.nek.state !== "ready") {
      throw new Error(t("settings.nek.hosts.copyDisabled"));
    }
    await refreshTargets();
    setDialog({ kind: "copy", host: currentHost });
  }

  // This intent is consumed once per settings navigation. A fresh click or explicit retry starts a new attempt.
  const autoCopy = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      intent?.action !== "copy" ||
      !focusedHost ||
      error ||
      dialog ||
      autoCopy.current === focusedHostId
    )
      return;
    autoCopy.current = focusedHostId;
    setDirectCopyStatus("loading");
    void openCopy(focusedHost, intent.target).then(
      () => setDirectCopyStatus(null),
      (cause) => setDirectCopyStatus(getErrorMessage(cause)),
    );
  }, [intent, focusedHost, focusedHostId, error, dialog]);

  return (
    <NekPageFrame
      usesTarget={false}
      showMockBadge
      description={t("settings.nek.hosts.pageDescription")}
      actions={
        <Button onClick={() => setDialog({ kind: "add" })}>
          <PlusIcon aria-hidden="true" />
          {t("settings.nek.hosts.add")}
        </Button>
      }
    >
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {t("common.retry")}
          </Button>
        </div>
      ) : null}
      {!hosts && !error ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {t("common.loading")}
        </p>
      ) : null}
      {unresolved && !error ? (
        <p role="alert" className="text-ui-sm text-warning">
          {t("settings.nek.hostProjects.unresolved")}
        </p>
      ) : null}
      {directCopyStatus === "loading" ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {t("settings.nek.hostProjects.preparingCopy")}
        </p>
      ) : directCopyStatus && focusedHost ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-ui-sm text-destructive">
            {directCopyStatus}
          </p>
          <AsyncButton
            variant="outline"
            size="sm"
            successFeedback="none"
            onClick={async () => {
              await openCopy(focusedHost, intent?.target);
              setDirectCopyStatus(null);
            }}
          >
            {t("common.retry")}
          </AsyncButton>
        </div>
      ) : null}
      {hosts?.length === 0 ? (
        <NekEmptyState
          icon={<ServerIcon className="size-5" aria-hidden="true" />}
          title={t("settings.nek.hosts.emptyTitle")}
          description={t("settings.nek.hosts.emptyDescription")}
        />
      ) : null}
      {hosts?.length ? (
        <div className="flex flex-col gap-3">
          {hosts.map((host) => (
            <RemoteHostCard
              key={host.connectionId}
              host={host}
              highlighted={host.connectionId === focusedHostId}
              projects={projectGroups.get(host.connectionId)}
              onOpenProject={onOpenProject}
              onOpen={(kind) => setDialog({ kind, host })}
              onCopy={() => openCopy(host)}
            />
          ))}
        </div>
      ) : null}
      {hosts && !error ? (
        <SshAliasList hosts={hosts} edit={(alias) => setDialog({ kind: "add", alias })} />
      ) : null}
      {dialog?.kind === "add" || (dialog?.kind === "edit" && current) ? (
        <HostEditDialog
          open
          onOpenChange={(open) => !open && close()}
          isWindowsDesktop={isWindowsDesktop}
          host={dialog.kind === "edit" ? snapshot : undefined}
          initialTarget={dialog.kind === "add" ? dialog.target : undefined}
          initialAlias={dialog.kind === "add" ? dialog.alias : undefined}
          onSave={async (alias, target) => {
            await api.saveHost({
              alias,
              target,
              connectionId: dialog.kind === "edit" ? current?.connectionId : undefined,
            });
            await refreshTargets();
          }}
        />
      ) : null}
      {current && dialog ? (
        <>
          <InstallNekDialog
            open={dialog.kind === "install"}
            onOpenChange={(open) => !open && close()}
            host={current}
          />
          <FingerprintsDialog
            open={dialog.kind === "fingerprints"}
            onOpenChange={(open) => !open && close()}
            host={current}
          />
          {dialog.kind === "copy" ? (
            <CopyToHostDialog
              open
              onOpenChange={(open) => !open && close()}
              target={{ kind: "remote", connectionId: current.connectionId }}
              hostLabel={current.alias}
            />
          ) : null}
          <NekConfirmDialog
            open={dialog.kind === "delete"}
            onOpenChange={(open) => !open && close()}
            title={t("settings.nek.hosts.deleteTitle", { host: current.alias })}
            description={t("settings.nek.hosts.deleteDescription")}
            confirmLabel={t("settings.nek.hosts.delete")}
            destructive
            onConfirm={async () => {
              await api.deleteHost(current.connectionId);
              await refreshTargets();
            }}
          />
        </>
      ) : null}
    </NekPageFrame>
  );
}

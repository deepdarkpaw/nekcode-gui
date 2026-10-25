/**
 * 远程主机：别名、`user@host:port`、认证方式、指纹、nek 版本、连接状态；
 * 添加 / 编辑（复用远程连接表单）、测试连接、连接 / 断开、安装 / 更新 nek、查看或移除指纹、
 * "从本机复制到此主机"、删除（确认）。GUI 自身设置，不显示配置目标切换。
 */
import { useCallback, useEffect, useState } from "react";
import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FingerprintIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  ServerIcon,
  Unplug,
} from "lucide-react";
import type { RemoteTarget } from "@zcode/shared";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
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
import { useNekHostApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { toNekConfigApiError } from "../../api/nekErrors.js";
import { NekEmptyState } from "../../components/DocumentStatus.js";
import { NekConfirmDialog } from "../../components/NekConfirmDialog.js";
import { NekPageFrame } from "../../components/NekPageFrame.js";
import { CopyToHostDialog } from "./CopyToHostDialog.js";
import { HostEditDialog } from "./HostEditDialog.js";
import { FingerprintsDialog, InstallNekDialog } from "./HostDialogs.js";

type HostDialog = "edit" | "install" | "fingerprints" | "copy" | "delete";

export function describeRemoteTarget(target: RemoteTarget): string {
  if (target.kind === "ssh") return `${target.username}@${target.host}:${target.port ?? 22}`;
  if (target.kind === "wsl")
    return `wsl:${target.distro ?? "default"}${target.user ? ` (${target.user})` : ""}`;
  return `docker:${target.container}`;
}

const STATE_DOT: Record<NekRemoteHost["state"], string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  disconnected: "bg-foreground-subtlest",
  failed: "bg-destructive",
};

function useHosts() {
  const api = useNekHostApi();
  const [hosts, setHosts] = useState<NekRemoteHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setHosts(await api.listHosts());
      setError(null);
    } catch (cause) {
      setError(toNekConfigApiError(cause).message);
    }
  }, [api]);
  useEffect(() => {
    void reload();
    return api.onHostsChanged(() => void reload());
  }, [api, reload]);
  return { hosts, error, reload };
}

function HostCard({ host, onOpen }: { host: NekRemoteHost; onOpen: (dialog: HostDialog) => void }) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekHostApi();
  const { refreshTargets } = useNekTarget();
  const [testResult, setTestResult] = useState<string | null>(null);
  const connected = host.state === "connected";
  const nekText =
    host.nek.state === "ready"
      ? `nek ${host.nek.version}`
      : t(`settings.nek.hosts.nek.${host.nek.state}`, {
          version: "version" in host.nek ? host.nek.version : "",
        });
  return (
    <section
      aria-labelledby={`nek-host-${host.connectionId}`}
      className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-4"
    >
      <header className="flex items-start gap-3">
        <ServerIcon className="mt-0.5 size-5 text-foreground-subtle" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3
            id={`nek-host-${host.connectionId}`}
            className="flex items-center gap-2 text-ui-base font-medium"
          >
            {host.alias}
            <span className="flex items-center gap-1 text-ui-sm font-normal text-foreground-subtle">
              <span
                aria-hidden="true"
                className={cn("size-2 rounded-full", STATE_DOT[host.state])}
              />
              {t(`settings.nek.hosts.state.${host.state}`)}
            </span>
          </h3>
          <p className="font-mono text-ui-sm text-foreground-subtle">
            {describeRemoteTarget(host.target)}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {t(`settings.nek.hosts.auth.${host.authMethod}`)} · {nekText}
            {host.fingerprints[0] ? (
              <span className="ml-2 font-mono text-ui-xs">
                {host.fingerprints[0].fingerprint.slice(0, 22)}…
              </span>
            ) : null}
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
            <DropdownMenuItem variant="destructive" onSelect={() => onOpen("delete")}>
              {t("settings.nek.hosts.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="flex flex-wrap items-center gap-2">
        {connected ? (
          <AsyncButton
            variant="outline"
            icon={<Unplug />}
            successFeedback="none"
            onClick={async () => {
              await api.disconnectHost(host.connectionId);
              await refreshTargets();
            }}
          >
            {t("settings.nek.hosts.disconnect")}
          </AsyncButton>
        ) : (
          <AsyncButton
            icon={<PlugIcon />}
            successFeedback="none"
            onClick={async () => {
              await api.connectHost(host.connectionId);
              await refreshTargets();
            }}
          >
            {t("settings.nek.hosts.connect")}
          </AsyncButton>
        )}
        <AsyncButton
          variant="outline"
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
        <Button variant="outline" disabled={!connected} onClick={() => onOpen("install")}>
          <DownloadIcon aria-hidden="true" />
          {t(
            host.nek.state === "ready" || host.nek.state === "incompatible"
              ? "settings.nek.hosts.updateNek"
              : "settings.nek.hosts.installNek",
          )}
        </Button>
        <AsyncButton
          variant="outline"
          icon={<CopyIcon />}
          successFeedback="none"
          disabled={!connected || host.nek.state !== "ready"}
          disabledReason={t("settings.nek.hosts.copyDisabled")}
          onClick={() => onOpen("copy")}
        >
          {t("settings.nek.hosts.copyFromLocal")}
        </AsyncButton>
      </div>
    </section>
  );
}

export function RemoteHostsPage({ isWindowsDesktop = false }: { isWindowsDesktop?: boolean }) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekHostApi();
  const { refreshTargets } = useNekTarget();
  const { hosts, error } = useHosts();
  const [dialog, setDialog] = useState<{ kind: HostDialog | "add"; host?: NekRemoteHost } | null>(
    null,
  );
  const current = dialog?.host
    ? (hosts?.find((host) => host.connectionId === dialog.host?.connectionId) ?? dialog.host)
    : undefined;
  const close = () => setDialog(null);
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
        <p role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ) : null}
      {hosts && hosts.length === 0 ? (
        <NekEmptyState
          icon={<ServerIcon className="size-5" aria-hidden="true" />}
          title={t("settings.nek.hosts.emptyTitle")}
          description={t("settings.nek.hosts.emptyDescription")}
        />
      ) : null}
      <div className="flex flex-col gap-3">
        {hosts?.map((host) => (
          <HostCard
            key={host.connectionId}
            host={host}
            onOpen={(kind) => setDialog({ kind, host })}
          />
        ))}
      </div>
      <HostEditDialog
        open={dialog?.kind === "add" || dialog?.kind === "edit"}
        onOpenChange={(open) => !open && close()}
        host={dialog?.kind === "edit" ? current : undefined}
        isWindowsDesktop={isWindowsDesktop}
        onSave={async (alias, target) => {
          await api.saveHost({
            connectionId: dialog?.kind === "edit" ? current?.connectionId : undefined,
            alias,
            target,
          });
          await refreshTargets();
        }}
      />
      {current ? (
        <>
          <InstallNekDialog
            open={dialog?.kind === "install"}
            onOpenChange={(open) => !open && close()}
            host={current}
          />
          <FingerprintsDialog
            open={dialog?.kind === "fingerprints"}
            onOpenChange={(open) => !open && close()}
            host={current}
          />
          <CopyToHostDialog
            open={dialog?.kind === "copy"}
            onOpenChange={(open) => !open && close()}
            target={{ kind: "remote", connectionId: current.connectionId }}
            hostLabel={current.alias}
          />
          <NekConfirmDialog
            open={dialog?.kind === "delete"}
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

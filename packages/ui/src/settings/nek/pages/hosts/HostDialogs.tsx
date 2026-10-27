/**
 * 主机相关对话框：安装 / 更新 nek（实时日志，失败给出可复制的手动安装命令）；
 * 查看与移除已记录的主机指纹（不可逆，确认框默认焦点在"取消"）。
 */
import { useEffect, useRef, useState } from "react";
import { Trash2Icon } from "lucide-react";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { Input } from "@/components/ui/input.js";
import { SettingAdvancedGroup } from "@/components/ui/setting-fields.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatDate } from "@/lib/displayFormat.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import type {
  NekHostFingerprint,
  NekInstallOptions,
  NekInstallResult,
  NekRemoteHost,
} from "../../api/hostApi.js";
import { useNekHostApi } from "../../api/NekSettingsContext.js";
import { CopyButton, Segmented } from "../../components/inputs.js";
import { NekConfirmDialog } from "../../components/NekConfirmDialog.js";

const MAX_LOG_LINES = 500;

export function InstallNekDialog({
  open,
  onOpenChange,
  host,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: NekRemoteHost;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekHostApi();
  const focusRestore = useFocusRestore(open);
  const [options, setOptions] = useState<NekInstallOptions>({ channel: "stable" });
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<NekInstallResult | null>(null);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open) {
      setLogs([]);
      setResult(null);
      setRunning(false);
    }
  }, [open]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);
  const updating = host.nek.state === "ready" || host.nek.state === "incompatible";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" onCloseAutoFocus={focusRestore.onCloseAutoFocus}>
        <DialogHeader className="pr-8">
          <DialogTitle>
            {t(
              updating
                ? "settings.nek.hosts.install.updateTitle"
                : "settings.nek.hosts.install.title",
              { host: host.alias },
            )}
          </DialogTitle>
          <DialogDescription>{t("settings.nek.hosts.install.description")}</DialogDescription>
        </DialogHeader>
        <Segmented<"stable" | "dev">
          ariaLabel={t("settings.nek.about.channel")}
          value={options.channel ?? "stable"}
          options={[
            { value: "stable", label: t("settings.nek.about.channel.stable") },
            { value: "dev", label: t("settings.nek.about.channel.dev") },
          ]}
          onChange={(channel) => setOptions((current) => ({ ...current, channel }))}
        />
        <SettingAdvancedGroup title={t("settings.nek.hosts.install.mirrors")}>
          <div className="grid gap-2">
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              aria-label="NEK_REPO_URL"
              placeholder="NEK_REPO_URL"
              className="font-mono"
              value={options.repoUrl ?? ""}
              onChange={(event) =>
                setOptions((current) => ({ ...current, repoUrl: event.target.value || undefined }))
              }
            />
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              aria-label="NEK_NODE_MIRROR"
              placeholder="NEK_NODE_MIRROR"
              className="font-mono"
              value={options.nodeMirror ?? ""}
              onChange={(event) =>
                setOptions((current) => ({
                  ...current,
                  nodeMirror: event.target.value || undefined,
                }))
              }
            />
          </div>
        </SettingAdvancedGroup>
        {logs.length > 0 ? (
          <pre
            ref={logRef}
            aria-live="polite"
            className="max-h-48 overflow-y-auto rounded-xl bg-surface p-3 font-mono text-ui-sm text-foreground"
          >
            {logs.join("\n")}
          </pre>
        ) : null}
        {result && !result.ok ? (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-ui-sm text-destructive">{result.message}</p>
            <p className="text-ui-sm text-foreground-subtle">
              {t("settings.nek.hosts.install.manual")}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-ui-sm">
                {result.manualCommand}
              </code>
              <CopyButton
                text={result.manualCommand}
                label={t("settings.nek.hosts.install.copyCommand")}
              />
            </div>
          </div>
        ) : null}
        {result?.ok ? (
          <p role="status" className="text-ui-sm text-success">
            {t("settings.nek.hosts.install.done", { version: result.version })}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t(result || running ? "common.close" : "common.cancel")}
          </Button>
          {running ? (
            <Button
              variant="secondary"
              onClick={async () => {
                await api.cancelInstall(host.connectionId);
              }}
            >
              {t("settings.nek.hosts.install.cancel")}
            </Button>
          ) : null}
          <AsyncButton
            onClick={async () => {
              setLogs([]);
              setResult(null);
              setRunning(true);
              try {
                const outcome = await api.installNek(host.connectionId, options, (line) =>
                  setLogs((current) => [...current, line].slice(-MAX_LOG_LINES)),
                );
                setResult(outcome);
                if (!outcome.ok) throw new Error(outcome.message);
              } finally {
                setRunning(false);
              }
            }}
          >
            {t(
              updating ? "settings.nek.hosts.install.updateRun" : "settings.nek.hosts.install.run",
            )}
          </AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FingerprintsDialog({
  open,
  onOpenChange,
  host,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: NekRemoteHost;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekHostApi();
  const focusRestore = useFocusRestore(open);
  const [removing, setRemoving] = useState<NekHostFingerprint | null>(null);
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl" onCloseAutoFocus={focusRestore.onCloseAutoFocus}>
          <DialogHeader className="pr-8">
            <DialogTitle>
              {t("settings.nek.hosts.fingerprints.title", { host: host.alias })}
            </DialogTitle>
            <DialogDescription>
              {t("settings.nek.hosts.fingerprints.description")}
            </DialogDescription>
          </DialogHeader>
          {host.fingerprints.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {t("settings.nek.hosts.fingerprints.empty")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {host.fingerprints.map((item) => (
                <li
                  key={item.fingerprint}
                  className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="break-all font-mono text-ui-sm">{item.fingerprint}</span>
                    <span className="text-ui-xs text-foreground-subtle">
                      {item.keyType} ·{" "}
                      {t("settings.nek.hosts.fingerprints.added", {
                        date: formatDate(item.addedAt),
                      })}
                    </span>
                  </span>
                  <CopyButton
                    text={item.fingerprint}
                    label={t("settings.nek.hosts.fingerprints.copy")}
                  />
                  <IconButton
                    size="icon-sm"
                    label={t("settings.nek.hosts.fingerprints.remove")}
                    onClick={() => setRemoving(item)}
                  >
                    <Trash2Icon />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("common.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NekConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={t("settings.nek.hosts.fingerprints.removeTitle")}
        description={t("settings.nek.hosts.fingerprints.removeDescription", { host: host.alias })}
        confirmLabel={t("settings.nek.hosts.fingerprints.remove")}
        destructive
        onConfirm={async () => {
          if (removing) await api.removeFingerprint(host.connectionId, removing.fingerprint);
        }}
      >
        {removing ? (
          <code className="break-all font-mono text-ui-sm">{removing.fingerprint}</code>
        ) : null}
      </NekConfirmDialog>
    </>
  );
}

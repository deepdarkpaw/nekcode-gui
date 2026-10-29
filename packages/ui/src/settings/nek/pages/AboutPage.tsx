/**
 * 关于：GUI 版本与 nek 版本；nek 更新通道、检查更新与执行更新（`nek update`，实时日志）；
 * 日志与诊断信息导出。
 */
import { useEffect, useRef, useState } from "react";
import { DownloadIcon, FileArchiveIcon, FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import type { NekAppInfo, NekUpdateCheck } from "../api/hostApi.js";
import { Button } from "@/components/ui/button.js";
import { AsyncButton } from "@/components/ui/async-button.js";
import { requestNekOnboardingOpen } from "@/onboarding/NekOnboardingModal.js";
import { SettingRow, SettingSection, SettingSelectField } from "@/components/ui/setting-fields.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/lib/displayFormat.js";
import { useNekHostApi, useNekTarget } from "../api/NekSettingsContext.js";
import { toNekConfigApiError } from "../api/nekErrors.js";
import { useNekSettingsDoc } from "../api/settingsDocs.js";
import { CopyButton } from "../components/inputs.js";
import { NekPageFrame } from "../components/NekPageFrame.js";

const MAX_LOG_LINES = 300;

function useAppInfo() {
  const host = useNekHostApi();
  const [info, setInfo] = useState<NekAppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    host
      .getAppInfo()
      .then(setInfo, (cause: unknown) => setError(toNekConfigApiError(cause).message));
  }, [host]);
  return { info, error };
}

function UpdateSection() {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const host = useNekHostApi();
  const { target, targetInfo, refreshTargets } = useNekTarget();
  const settings = useNekSettingsDoc();
  const [check, setCheck] = useState<NekUpdateCheck | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    setCheck(null);
    setLogs([]);
  }, [target]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);
  const nek = targetInfo?.nek;
  const nekText =
    nek?.state === "ready"
      ? nek.version
      : t(`settings.nek.hosts.nek.${nek?.state ?? "unknown"}`, {
          version: nek && "version" in nek ? nek.version : "",
        });
  return (
    <SettingSection title={t("settings.nek.about.nek", { host: targetInfo?.label ?? "" })}>
      <SettingRow
        label={t("settings.nek.about.nekVersion")}
        description={nek?.state === "incompatible" ? nek.message : undefined}
      >
        <span className="font-mono text-ui-base">{nekText}</span>
      </SettingRow>
      {settings.data ? (
        <SettingSelectField
          label={t("settings.nek.about.channel")}
          description={t("settings.nek.about.channelHint")}
          value={
            settings.data.values.updateChannel ?? settings.data.defaults.updateChannel ?? "stable"
          }
          options={[
            { value: "stable", label: t("settings.nek.about.channel.stable") },
            { value: "dev", label: t("settings.nek.about.channel.dev") },
          ]}
          onCommit={(updateChannel) => settings.patch({ updateChannel })}
        />
      ) : null}
      <SettingRow
        label={t("settings.nek.about.update")}
        description={
          check
            ? t(
                check.updateAvailable
                  ? "settings.nek.about.updateAvailable"
                  : "settings.nek.about.upToDate",
                { current: check.current, latest: check.latest },
              )
            : t("settings.nek.about.updateHint")
        }
      >
        <div className="flex items-center gap-2">
          <AsyncButton
            variant="outline"
            icon={<RefreshCwIcon />}
            disabled={nek?.state !== "ready" && nek?.state !== "incompatible"}
            disabledReason={t("settings.nek.about.nekMissing")}
            onClick={async () => setCheck(await host.checkNekUpdate(target))}
          >
            {t("settings.nek.about.check")}
          </AsyncButton>
          {check?.updateAvailable ? (
            <AsyncButton
              icon={<DownloadIcon />}
              onClick={async () => {
                setLogs([]);
                await host.runNekUpdate(target, (line) =>
                  setLogs((current) => [...current, line].slice(-MAX_LOG_LINES)),
                );
                setCheck(null);
                await refreshTargets();
              }}
            >
              {t("settings.nek.about.runUpdate", { version: check.latest })}
            </AsyncButton>
          ) : null}
        </div>
      </SettingRow>
      {logs.length > 0 ? (
        <pre
          ref={logRef}
          aria-live="polite"
          className="max-h-40 overflow-y-auto rounded-xl bg-surface p-3 font-mono text-ui-sm"
        >
          {logs.join("\n")}
        </pre>
      ) : null}
    </SettingSection>
  );
}

function DiagnosticsSection() {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const host = useNekHostApi();
  const [exported, setExported] = useState<{ path: string; sizeBytes: number } | null>(null);
  return (
    <SettingSection title={t("settings.nek.about.diagnostics")}>
      <SettingRow
        label={t("settings.nek.about.export")}
        description={
          exported ? (
            <span className="flex items-center gap-1">
              <span className="font-mono">{exported.path}</span> · {formatBytes(exported.sizeBytes)}
              <CopyButton text={exported.path} label={t("settings.nek.about.copyPath")} />
            </span>
          ) : (
            t("settings.nek.about.exportHint")
          )
        }
      >
        <AsyncButton
          variant="outline"
          icon={<FileArchiveIcon />}
          onClick={async () => setExported(await host.exportDiagnostics())}
        >
          {t("settings.nek.about.exportRun")}
        </AsyncButton>
      </SettingRow>
      <SettingRow label={t("settings.nek.about.logs")}>
        <AsyncButton
          variant="ghost"
          icon={<FolderOpenIcon />}
          successFeedback="none"
          onClick={() => host.openLogsDirectory()}
        >
          {t("settings.nek.about.openLogs")}
        </AsyncButton>
      </SettingRow>
    </SettingSection>
  );
}

export function AboutPage() {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const { info, error } = useAppInfo();
  return (
    <NekPageFrame usesTarget description={t("settings.nek.about.pageDescription")}>
      <div className="flex flex-col gap-8">
        <SettingSection title={t("settings.nek.about.gui")}>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          <SettingRow label={t("settings.nek.about.guiVersion")}>
            <span className="font-mono text-ui-base">{info?.guiVersion ?? "—"}</span>
          </SettingRow>
          <SettingRow label={t("settings.nek.about.platform")}>
            <span className="font-mono text-ui-base">{info?.platform ?? "—"}</span>
          </SettingRow>
          <SettingRow label={t("settings.shortcuts.command.openOnboarding")}>
            <Button type="button" variant="outline" onClick={requestNekOnboardingOpen}>
              {t("settings.shortcuts.command.openOnboarding")}
            </Button>
          </SettingRow>
        </SettingSection>
        <UpdateSection />
        <DiagnosticsSection />
      </div>
    </NekPageFrame>
  );
}

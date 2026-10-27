/**
 * 高级：重试、httpProxy、httpIdleTimeoutMs、transport；steering / follow-up 队列模式；项目信任默认策略；
 * 原始 JSON 编辑（保存前 schema 校验，只写改动的键）；打开配置目录；重新载入运行中的会话。
 */
import { useEffect, useRef, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import type { NekSettingsView } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import {
  SettingAdvancedGroup,
  SettingRow,
  SettingSection,
  SettingSelectField,
  SettingSwitchField,
} from "@/components/ui/setting-fields.js";
import { SettingNumberField, SettingTextField } from "@/components/ui/setting-text-field.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { useNekConfigApi, useNekTarget } from "../api/NekSettingsContext.js";
import { useNekSettingsDoc, type NekSettingsDocument } from "../api/settingsDocs.js";
import { useNekDirtyRegistration, useOnDocumentReset } from "../api/useNekDocument.js";
import { validateRawSettings, type RawSettingsValidation } from "../lib/rawSettingsSchema.js";
import {
  diffSettingsValues,
  nestedSettingsPatch,
  rawDiffToSettingsPatch,
  settingsViewToJson,
  type NestedSettingsPatch,
} from "../lib/settingsPatch.js";
import { DocumentGate } from "../components/DocumentStatus.js";
import { NekPageFrame } from "../components/NekPageFrame.js";
import { OpenDirectoryButton } from "./agent/AgentPage.js";

type Retry = NonNullable<NekSettingsView["retry"]>;
const RETRY_NUMBERS = [
  ["maxRetries", "count"],
  ["baseDelayMs", "ms"],
  ["maxAgentDelayMs", "ms"],
] as const;
const PROVIDER_RETRY_NUMBERS = [
  ["timeoutMs", "ms"],
  ["maxRetries", "count"],
  ["maxRetryDelayMs", "ms"],
] as const;

function RetrySection({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const values: Retry = settings.data?.values.retry ?? {};
  const defaults: Retry = settings.data?.defaults.retry ?? {};
  const write = (retry: NonNullable<NestedSettingsPatch["retry"]>) =>
    settings.patch(nestedSettingsPatch({ retry }));
  return (
    <SettingSection
      title={t("settings.nek.advanced.retry")}
      description={t("settings.nek.advanced.retryHint")}
    >
      <SettingSwitchField
        label={t("settings.nek.advanced.retry.enabled")}
        value={values.enabled ?? defaults.enabled ?? true}
        onCommit={(enabled) => write({ enabled })}
      />
      {RETRY_NUMBERS.map(([field, unit]) => (
        <SettingNumberField
          key={field}
          label={t(`settings.nek.advanced.retry.${field}`)}
          unit={t(`settings.nek.unit.${unit}`)}
          integer
          min={0}
          value={values[field] ?? defaults[field] ?? 0}
          defaultValue={defaults[field]}
          onCommit={(value) => write({ [field]: value === defaults[field] ? null : value })}
        />
      ))}
      <SettingAdvancedGroup title={t("settings.nek.advanced.retry.provider")}>
        {PROVIDER_RETRY_NUMBERS.map(([field, unit]) => (
          <SettingNumberField
            key={field}
            label={t(`settings.nek.advanced.retry.provider.${field}`)}
            unit={t(`settings.nek.unit.${unit}`)}
            integer
            min={0}
            value={values.provider?.[field] ?? defaults.provider?.[field] ?? 0}
            defaultValue={defaults.provider?.[field]}
            onCommit={(value) =>
              write({ provider: { [field]: value === defaults.provider?.[field] ? null : value } })
            }
          />
        ))}
      </SettingAdvancedGroup>
    </SettingSection>
  );
}

function NetworkSection({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const values = settings.data?.values ?? {};
  const defaults = settings.data?.defaults ?? {};
  return (
    <SettingSection title={t("settings.nek.advanced.network")}>
      <SettingTextField
        label={t("settings.nek.advanced.httpProxy")}
        description={t("settings.nek.advanced.httpProxyHint")}
        value={values.httpProxy ?? ""}
        placeholder="http://127.0.0.1:7890"
        inputClassName="w-72 font-mono"
        validate={(value) =>
          value === "" || /^(https?|socks5h?):\/\/\S+$/.test(value)
            ? null
            : t("settings.nek.advanced.httpProxyInvalid")
        }
        onCommit={(httpProxy) => settings.patch({ httpProxy: httpProxy || null })}
      />
      <SettingNumberField
        label={t("settings.nek.advanced.httpIdleTimeout")}
        unit={t("settings.nek.unit.ms")}
        integer
        min={0}
        value={values.httpIdleTimeoutMs ?? defaults.httpIdleTimeoutMs ?? 0}
        defaultValue={defaults.httpIdleTimeoutMs}
        onCommit={(value) =>
          settings.patch({ httpIdleTimeoutMs: value === defaults.httpIdleTimeoutMs ? null : value })
        }
      />
      <SettingSelectField
        label={t("settings.nek.advanced.transport")}
        description={t("settings.nek.advanced.transportHint")}
        value={values.transport ?? defaults.transport ?? "auto"}
        options={["auto", "sse", "websocket", "websocket-cached"].map((value) => ({
          value,
          label: t(`settings.nek.advanced.transport.${value}`),
        }))}
        onCommit={(transport) =>
          settings.patch({ transport: transport === defaults.transport ? null : transport })
        }
      />
    </SettingSection>
  );
}

function BehaviorSection({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const values = settings.data?.values ?? {};
  const queueOptions = (["one-at-a-time", "all"] as const).map((value) => ({
    value,
    label: t(`settings.nek.advanced.queue.${value}`),
  }));
  return (
    <SettingSection title={t("settings.nek.advanced.behavior")}>
      <SettingSelectField
        label={t("settings.nek.advanced.steeringMode")}
        description={t("settings.nek.advanced.steeringModeHint")}
        value={values.steeringMode ?? "one-at-a-time"}
        options={queueOptions}
        onCommit={(steeringMode) => settings.patch({ steeringMode })}
      />
      <SettingSelectField
        label={t("settings.nek.advanced.followUpMode")}
        description={t("settings.nek.advanced.followUpModeHint")}
        value={values.followUpMode ?? "one-at-a-time"}
        options={queueOptions}
        onCommit={(followUpMode) => settings.patch({ followUpMode })}
      />
      <SettingSelectField
        label={t("settings.nek.advanced.defaultProjectTrust")}
        value={values.defaultProjectTrust ?? "ask"}
        options={(["ask", "always", "never"] as const).map((value) => ({
          value,
          label: t(`settings.nek.project.policy.${value}`),
        }))}
        onCommit={(defaultProjectTrust) => settings.patch({ defaultProjectTrust })}
      />
    </SettingSection>
  );
}

function formatJson(settings: NekSettingsDocument): string {
  return settings.data ? JSON.stringify(settingsViewToJson(settings.data.values), null, 2) : "";
}

function RawJsonSection({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const saved = formatJson(settings);
  const [text, setText] = useState(saved);
  const dirty = text !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setText(saved);
  }, [saved]);
  useOnDocumentReset(settings.resetToken, () => setText(formatJson(settings)));
  useNekDirtyRegistration([settings], dirty);
  const validation: RawSettingsValidation = validateRawSettings(text);
  return (
    <SettingAdvancedGroup title={t("settings.nek.advanced.rawJson")}>
      <p className="text-ui-sm text-foreground-subtle">
        {t("settings.nek.advanced.rawJsonHint", { path: settings.data?.path ?? "" })}
      </p>
      <Textarea
        {...TECHNICAL_INPUT_ATTRIBUTES}
        aria-label={t("settings.nek.advanced.rawJson")}
        aria-invalid={!validation.ok || undefined}
        value={text}
        className="min-h-64 font-mono"
        onChange={(event) => setText(event.target.value)}
      />
      {!validation.ok ? (
        <ul role="alert" className="flex flex-col gap-0.5 text-ui-sm text-destructive">
          {validation.kind === "syntax" ? (
            <li>{t("settings.nek.advanced.rawJsonSyntax", { message: validation.message })}</li>
          ) : (
            validation.issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <span className="font-mono">{issue.path || "/"}</span>: {issue.message}
              </li>
            ))
          )}
        </ul>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={!dirty} onClick={() => setText(saved)}>
          {t("settings.nek.instructions.revert")}
        </Button>
        <AsyncButton
          variant="secondary"
          disabled={!dirty || !validation.ok}
          disabledReason={t(
            dirty ? "settings.nek.advanced.rawJsonInvalid" : "settings.nek.instructions.noChanges",
          )}
          onClick={async () => {
            if (!validation.ok || !settings.data) return;
            const diff = diffSettingsValues(
              settingsViewToJson(settings.data.values),
              validation.value,
            );
            await settings.patch(rawDiffToSettingsPatch(diff));
          }}
        >
          {t("settings.nek.advanced.rawJsonSave")}
        </AsyncButton>
      </div>
    </SettingAdvancedGroup>
  );
}

function MaintenanceSection() {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekConfigApi();
  const { target, targetInfo } = useNekTarget();
  const [reloadResult, setReloadResult] = useState<string | null>(null);
  const agentDir = targetInfo?.nek.state === "ready" ? targetInfo.nek.agentDir : undefined;
  return (
    <SettingSection title={t("settings.nek.advanced.maintenance")}>
      <SettingRow
        label={t("settings.nek.advanced.configDir")}
        description={agentDir ? <span className="font-mono">{agentDir}</span> : "—"}
      >
        {agentDir ? <OpenDirectoryButton target={target} path={agentDir} /> : null}
      </SettingRow>
      <SettingRow
        label={t("settings.nek.advanced.reload")}
        description={reloadResult ?? t("settings.nek.advanced.reloadHint")}
      >
        <AsyncButton
          variant="outline"
          icon={<RefreshCwIcon />}
          onClick={async () => {
            const result = await api.reloadRunningSessions(target);
            setReloadResult(
              t("settings.nek.advanced.reloadResult", {
                reloaded: result.reloaded,
                deferred: result.deferred,
              }),
            );
          }}
        >
          {t("settings.nek.advanced.reloadRun")}
        </AsyncButton>
      </SettingRow>
    </SettingSection>
  );
}

export function AdvancedPage() {
  const { intl } = useZCodeIntl();
  const settings = useNekSettingsDoc();
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.advanced.pageDescription" })}
      documents={[settings]}
    >
      <DocumentGate documents={[settings]}>
        {() => (
          <div className="flex flex-col gap-8">
            <RetrySection settings={settings} />
            <NetworkSection settings={settings} />
            <BehaviorSection settings={settings} />
            <RawJsonSection settings={settings} />
            <MaintenanceSection />
          </div>
        )}
      </DocumentGate>
    </NekPageFrame>
  );
}

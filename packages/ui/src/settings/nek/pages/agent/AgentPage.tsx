/**
 * Agent：nek.yaml（plan 目录与模式快捷键、todo 结束提醒、子代理并发 / 保留 / 等待上限）、
 * 子代理预设、全局 AGENTS.md 与约定的全局扩展目录。
 */
import { FolderOpenIcon } from "lucide-react";
import type { NekConfigTarget } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { SettingSection, SettingSwitchField } from "@/components/ui/setting-fields.js";
import { SettingNumberField, SettingTextField } from "@/components/ui/setting-text-field.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/lib/displayFormat.js";
import { useNekHostApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { useModelScopeCwd } from "../../api/useModelScopeCwd.js";
import { useNekAgentPresetsDoc } from "../../api/mcpDocs.js";
import { useNekYamlDoc, yamlValue, type NekYamlDocument } from "../../api/settingsDocs.js";
import { useNekQuery } from "../../api/useNekQuery.js";
import { DocumentGate } from "../../components/DocumentStatus.js";
import { NekPageFrame } from "../../components/NekPageFrame.js";
import { AgentPresetsSection } from "./AgentPresetsSection.js";
import { InstructionsEditor } from "./InstructionsEditor.js";

const SUBAGENT_NUMBERS = [
  ["maxConcurrent", "count"],
  ["maxRetained", "count"],
  ["awaitDefaultMs", "ms"],
  ["awaitMaxMs", "ms"],
  ["finalTextMaxBytes", "bytes"],
] as const;

function YamlSection({ yaml }: { yaml: NekYamlDocument }) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const defaults = yaml.data?.defaults;
  if (!defaults) return null;
  return (
    <SettingSection
      title={t("settings.nek.agent.yamlTitle")}
      description={<span className="font-mono">{yaml.data?.path}</span>}
    >
      <SettingTextField
        label={t("settings.nek.agent.planDir")}
        description={t("settings.nek.agent.planDirHint")}
        value={yamlValue(yaml.data, "plan", "dir") ?? ""}
        defaultValue={defaults.plan.dir}
        inputClassName="w-56 font-mono"
        validate={(value) => (value ? null : t("settings.nek.common.required"))}
        onCommit={(dir) => yaml.patch({ plan: { dir: dir === defaults.plan.dir ? null : dir } })}
      />
      <SettingTextField
        label={t("settings.nek.agent.planShortcut")}
        description={t("settings.nek.agent.planShortcutHint")}
        value={yamlValue(yaml.data, "plan", "shortcut") ?? ""}
        defaultValue={defaults.plan.shortcut}
        inputClassName="w-40 font-mono"
        validate={(value) =>
          /^([a-z]+\+)*[a-z0-9]+$/i.test(value) ? null : t("settings.nek.agent.planShortcutInvalid")
        }
        onCommit={(shortcut) =>
          yaml.patch({ plan: { shortcut: shortcut === defaults.plan.shortcut ? null : shortcut } })
        }
      />
      <SettingSwitchField
        label={t("settings.nek.agent.settleReminder")}
        description={t("settings.nek.agent.settleReminderHint")}
        value={yamlValue(yaml.data, "todo", "settleReminder") ?? true}
        onCommit={(settleReminder) => yaml.patch({ todo: { settleReminder } })}
      />
      <SettingNumberField
        label={t("settings.nek.agent.widgetMaxLines")}
        integer
        min={1}
        unit={t("settings.nek.unit.lines")}
        value={yamlValue(yaml.data, "todo", "widgetMaxLines") ?? defaults.todo.widgetMaxLines}
        defaultValue={defaults.todo.widgetMaxLines}
        onCommit={(value) =>
          yaml.patch({
            todo: { widgetMaxLines: value === defaults.todo.widgetMaxLines ? null : value },
          })
        }
      />
      {SUBAGENT_NUMBERS.map(([field, unit]) => {
        const value = yamlValue(yaml.data, "subagent", field) ?? defaults.subagent[field];
        return (
          <SettingNumberField
            key={field}
            label={t(`settings.nek.agent.subagent.${field}`)}
            description={
              unit === "bytes"
                ? formatBytes(value)
                : unit === "ms"
                  ? t("settings.nek.agent.seconds", { s: Math.round(value / 1000) })
                  : undefined
            }
            integer
            min={unit === "count" ? 1 : 0}
            unit={t(`settings.nek.unit.${unit}`)}
            value={value}
            defaultValue={defaults.subagent[field]}
            onCommit={(next) =>
              yaml.patch({ subagent: { [field]: next === defaults.subagent[field] ? null : next } })
            }
          />
        );
      })}
    </SettingSection>
  );
}

export function OpenDirectoryButton({ target, path }: { target: NekConfigTarget; path: string }) {
  const { intl } = useZCodeIntl();
  const host = useNekHostApi();
  return (
    <AsyncButton
      variant="ghost"
      size="sm"
      icon={<FolderOpenIcon />}
      successFeedback="none"
      disabled={target.kind === "remote"}
      disabledReason={intl.formatMessage({ id: "settings.nek.openDir.remote" }, { path })}
      onClick={() => host.openPath(target, path)}
    >
      {intl.formatMessage({ id: "settings.nek.openDir" })}
    </AsyncButton>
  );
}

function ResourcesSection() {
  const { intl } = useZCodeIntl();
  const { target } = useNekTarget();
  const resources = useNekQuery((api, current) => api.listExtensions(current), []);
  return (
    <SettingSection
      title={intl.formatMessage({ id: "settings.nek.agent.extensions" })}
      description={intl.formatMessage({ id: "settings.nek.agent.extensionsHint" })}
    >
      <DocumentGate documents={[resources]}>
        {() =>
          resources.data && (
            <section className="flex flex-col gap-1 rounded-xl border border-card-border bg-card p-3">
              <header className="flex items-center justify-between gap-2">
                <span className="break-all font-mono text-ui-sm">{resources.data.directory}</span>
                <OpenDirectoryButton target={target} path={resources.data.directory} />
              </header>
              {resources.data.extensions.length ? (
                <ul className="flex flex-col gap-0.5">
                  {resources.data.extensions.map((item) => (
                    <li key={item.path} title={item.path} className="truncate font-mono text-ui-sm">
                      {item.name}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ui-sm text-foreground-subtle">—</p>
              )}
            </section>
          )
        }
      </DocumentGate>
    </SettingSection>
  );
}

export function AgentPage() {
  const { intl } = useZCodeIntl();
  const projectCwd = useModelScopeCwd();
  const yaml = useNekYamlDoc();
  const presets = useNekAgentPresetsDoc(projectCwd);
  const available = useNekQuery((api, target) => api.listAvailableModels(target), []);
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.agent.pageDescription" })}
      documents={[yaml, presets]}
    >
      <DocumentGate documents={[yaml]}>
        {() => (
          <div className="flex flex-col gap-8">
            <YamlSection yaml={yaml} />
            <AgentPresetsSection
              doc={presets}
              models={available.data ?? []}
              sources={["builtin", "user", "project"]}
              allowProjectScope={Boolean(projectCwd)}
              title={intl.formatMessage({ id: "settings.nek.agent.presets" })}
            />
            <InstructionsEditor
              scope="global"
              title={intl.formatMessage({ id: "settings.nek.agent.instructions" })}
            />
            <ResourcesSection />
          </div>
        )}
      </DocumentGate>
    </NekPageFrame>
  );
}

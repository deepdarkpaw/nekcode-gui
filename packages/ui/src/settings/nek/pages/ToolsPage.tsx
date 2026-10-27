/**
 * 工具与联网：内置工具勾选（写 `defaultTools` 的 `+name/-name`）；shell 路径与命令前缀；
 * 联网搜索开关（`-web_search`）、Exa API Key、自定义 endpoint（高级）、结果数、测试搜索。
 *
 * 工具清单来自 `listBuiltinTools()`（host 侧的 nek 镜像），不在界面里硬编码。
 */
import { useState } from "react";
import { RefreshCwIcon, SearchIcon } from "lucide-react";
import type { NekBuiltinTool } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  SaveStatusIndicator,
  SettingAdvancedGroup,
  SettingRow,
  SettingSection,
  SettingSwitchField,
} from "@/components/ui/setting-fields.js";
import { SettingNumberField, SettingTextField } from "@/components/ui/setting-text-field.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekConfigApi, useNekTarget } from "../api/NekSettingsContext.js";
import { useNekQuery } from "../api/useNekQuery.js";
import { useNekSettingsDoc, type NekSettingsDocument } from "../api/settingsDocs.js";
import {
  buildDefaultToolsSetting,
  resolveEnabledTools,
  WEB_SEARCH_TOOL,
} from "../lib/defaultTools.js";
import { nestedSettingsPatch } from "../lib/settingsPatch.js";
import { DocumentGate, NekEmptyState } from "../components/DocumentStatus.js";
import { NekPageFrame } from "../components/NekPageFrame.js";
import { SecretSettingField } from "../components/SecretSettingField.js";

function useToolsWriter(settings: NekSettingsDocument, knownTools: readonly string[]) {
  const defaults = settings.data?.defaults.defaultTools ?? [];
  const enabled = resolveEnabledTools(settings.data?.values.defaultTools, defaults);
  const write = (next: ReadonlySet<string>) =>
    settings.patch({ defaultTools: buildDefaultToolsSetting(next, defaults, knownTools) });
  const setTool = (name: string, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(name);
    else next.delete(name);
    return write(next);
  };
  return { enabled, defaults, setTool };
}

function BuiltinTools({
  settings,
  tools,
}: {
  settings: NekSettingsDocument;
  tools: readonly NekBuiltinTool[];
}) {
  const { intl } = useZCodeIntl();
  const known = tools.map((tool) => tool.name);
  const { enabled, setTool } = useToolsWriter(settings, known);
  const save = useAsyncAction((name: string, on: boolean) => setTool(name, on));
  const setting = settings.data?.values.defaultTools;
  return (
    <SettingSection
      title={
        <span className="flex items-center gap-2">
          {intl.formatMessage({ id: "settings.nek.tools.builtin" })}
          <SaveStatusIndicator state={save.state} />
        </span>
      }
      description={intl.formatMessage({ id: "settings.nek.tools.builtinHint" })}
    >
      {save.state.status === "error" ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {save.state.message}
        </p>
      ) : null}
      <div className="grid gap-1 sm:grid-cols-2">
        {tools
          .filter((tool) => tool.name !== WEB_SEARCH_TOOL)
          .map((tool) => (
            <label
              key={tool.name}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
            >
              <Checkbox
                className="mt-0.5"
                checked={enabled.has(tool.name)}
                onCheckedChange={(checked) => void save.run(tool.name, checked === true)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="font-mono text-ui-sm text-foreground">
                  {tool.name}
                  {tool.defaultActive ? null : (
                    <span className="ml-2 font-sans text-ui-xs text-foreground-subtlest">
                      {intl.formatMessage({ id: "settings.nek.tools.optional" })}
                    </span>
                  )}
                </span>
                <span className="text-ui-xs text-foreground-subtle">
                  {intl.formatMessage({ id: `settings.nek.tools.desc.${tool.name}` })}
                </span>
              </span>
            </label>
          ))}
      </div>
      <p className="font-mono text-ui-xs text-foreground-subtlest">
        defaultTools:{" "}
        {setting ? JSON.stringify(setting) : intl.formatMessage({ id: "settings.nek.tools.unset" })}
      </p>
    </SettingSection>
  );
}

function ShellSection({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const values = settings.data?.values ?? {};
  return (
    <SettingSection title={intl.formatMessage({ id: "settings.nek.tools.shell" })}>
      <SettingTextField
        label={intl.formatMessage({ id: "settings.nek.tools.shellPath" })}
        description={intl.formatMessage({ id: "settings.nek.tools.shellPathHint" })}
        value={values.shellPath ?? ""}
        placeholder={intl.formatMessage({ id: "settings.nek.tools.shellPathPlaceholder" })}
        inputClassName="w-72 font-mono"
        onCommit={(shellPath) => settings.patch({ shellPath: shellPath || null })}
      />
      <SettingTextField
        label={intl.formatMessage({ id: "settings.nek.tools.shellPrefix" })}
        description={intl.formatMessage({ id: "settings.nek.tools.shellPrefixHint" })}
        value={values.shellCommandPrefix ?? ""}
        placeholder="source ~/.profile &&"
        trim={false}
        inputClassName="w-72 font-mono"
        onCommit={(prefix) =>
          settings.patch({ shellCommandPrefix: prefix.trim() === "" ? null : prefix })
        }
      />
    </SettingSection>
  );
}

function WebSearchSection({
  settings,
  tools,
}: {
  settings: NekSettingsDocument;
  tools: readonly NekBuiltinTool[];
}) {
  const { intl } = useZCodeIntl();
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const { enabled, setTool } = useToolsWriter(
    settings,
    tools.map((tool) => tool.name),
  );
  const [result, setResult] = useState<string | null>(null);
  const web = settings.data?.values.webSearch ?? {};
  const defaults = settings.data?.defaults.webSearch ?? {};
  const on = enabled.has(WEB_SEARCH_TOOL);
  const writeWeb = (patch: {
    endpoint?: string | null;
    apiKey?: string | null;
    numResults?: number | null;
  }) => settings.patch(nestedSettingsPatch({ webSearch: patch }));
  return (
    <SettingSection
      title={intl.formatMessage({ id: "settings.nek.web.title" })}
      description={intl.formatMessage({ id: "settings.nek.web.description" })}
    >
      <SettingSwitchField
        label={intl.formatMessage({ id: "settings.nek.web.enabled" })}
        description={intl.formatMessage({ id: "settings.nek.web.enabledHint" })}
        value={on}
        onCommit={(next) => setTool(WEB_SEARCH_TOOL, next)}
      />
      <SecretSettingField
        label={intl.formatMessage({ id: "settings.nek.web.apiKey" })}
        description={intl.formatMessage({ id: "settings.nek.web.apiKeyHint" })}
        value={web.apiKey ?? ""}
        placeholder={intl.formatMessage({ id: "settings.nek.web.apiKeyPlaceholder" })}
        onCommit={(apiKey) => writeWeb({ apiKey: apiKey || null })}
      />
      <SettingNumberField
        label={intl.formatMessage({ id: "settings.nek.web.numResults" })}
        integer
        min={1}
        max={25}
        unit={intl.formatMessage({ id: "settings.nek.unit.count" })}
        value={web.numResults ?? defaults.numResults ?? 5}
        defaultValue={defaults.numResults}
        onCommit={(value) => writeWeb({ numResults: value === defaults.numResults ? null : value })}
      />
      <SettingRow
        label={intl.formatMessage({ id: "settings.nek.web.test" })}
        description={result ?? intl.formatMessage({ id: "settings.nek.web.testHint" })}
      >
        <AsyncButton
          variant="outline"
          icon={<SearchIcon />}
          disabled={!on}
          disabledReason={intl.formatMessage({ id: "settings.nek.web.testDisabled" })}
          onClick={async () => {
            setResult(null);
            const outcome = await api.testWebSearch(target, "nek coding agent");
            if (!outcome.ok) throw new Error(outcome.message);
            setResult(
              intl.formatMessage(
                { id: "settings.nek.web.testOk" },
                { ms: outcome.latencyMs, count: outcome.resultCount },
              ),
            );
          }}
        >
          {intl.formatMessage({ id: "settings.nek.web.testRun" })}
        </AsyncButton>
      </SettingRow>
      <SettingAdvancedGroup>
        <SettingTextField
          label={intl.formatMessage({ id: "settings.nek.web.endpoint" })}
          description={intl.formatMessage({ id: "settings.nek.web.endpointHint" })}
          value={web.endpoint ?? defaults.endpoint ?? ""}
          defaultValue={defaults.endpoint}
          inputClassName="w-72 font-mono"
          validate={(value) =>
            value === "" || /^https?:\/\//.test(value)
              ? null
              : intl.formatMessage({ id: "settings.nek.provider.error.baseUrlInvalid" })
          }
          onCommit={(endpoint) =>
            writeWeb({
              endpoint: endpoint === "" || endpoint === defaults.endpoint ? null : endpoint,
            })
          }
        />
      </SettingAdvancedGroup>
    </SettingSection>
  );
}

export function ToolsPage() {
  const { intl } = useZCodeIntl();
  const settings = useNekSettingsDoc();
  const tools = useNekQuery((config, current) => config.listBuiltinTools(current), []);
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.tools.pageDescription" })}
      documents={[settings]}
    >
      <DocumentGate documents={[settings, tools]}>
        {() => {
          const list = tools.data ?? [];
          return (
            <div className="flex flex-col gap-8">
              {list.length === 0 ? (
                <NekEmptyState
                  icon={<RefreshCwIcon className="size-5" aria-hidden="true" />}
                  title={intl.formatMessage({ id: "settings.nek.tools.builtinEmpty" })}
                  description={intl.formatMessage({ id: "settings.nek.tools.builtinEmptyHint" })}
                  action={
                    <Button variant="outline" onClick={() => void tools.reload()}>
                      <RefreshCwIcon aria-hidden="true" />
                      {intl.formatMessage({ id: "settings.nek.load.retry" })}
                    </Button>
                  }
                />
              ) : (
                <BuiltinTools settings={settings} tools={list} />
              )}
              <ShellSection settings={settings} />
              <WebSearchSection settings={settings} tools={list} />
            </div>
          );
        }}
      </DocumentGate>
    </NekPageFrame>
  );
}

/**
 * 工具与联网：内置工具勾选（写 `defaultTools` 的 `+name/-name`）；shell 路径与命令前缀；
 * 联网搜索开关（`-web_search`）、Tavily/Exa、API Key、自定义 endpoint（高级）、结果数、测试搜索。
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
  SettingSelectField,
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

/**
 * 默认工具集取自 host 返回的工具清单（`defaultActive`），即 nek 的 `DEFAULT_ACTIVE_TOOL_NAMES`；
 * settings 的 defaults 里没有 `defaultTools`，不能用它当基准。
 */
function useToolsWriter(settings: NekSettingsDocument, tools: readonly NekBuiltinTool[]) {
  const knownTools = tools.map((tool) => tool.name);
  const defaults = tools.filter((tool) => tool.defaultActive).map((tool) => tool.name);
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
  const { enabled, setTool } = useToolsWriter(settings, tools);
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

/**
 * nek 只认 tavily/exa；旧版本界面写下的 `endpoint`/`apiKey` 没有 provider，
 * 这时下拉保持空值并要求用户显式选择，绝不按默认值猜。
 */
function asSearchProvider(value: unknown): "tavily" | "exa" | undefined {
  return value === "tavily" || value === "exa" ? value : undefined;
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
  const { enabled, setTool } = useToolsWriter(settings, tools);
  const [result, setResult] = useState<string | null>(null);
  const web = settings.data?.values.webSearch ?? {};
  // 服务商的有效值来自默认值（Tavily），凭据只可能是用户写进本作用域的文件。
  const effective = settings.data?.effective.webSearch ?? {};
  const defaults = settings.data?.defaults.webSearch ?? {};
  const on = enabled.has(WEB_SEARCH_TOOL);
  const explicitProvider = asSearchProvider(web.provider);
  const provider =
    asSearchProvider(effective.provider) ?? asSearchProvider(defaults.provider) ?? "tavily";
  const hasCredentials = Boolean(web.apiKey || web.endpoint);
  const needsProvider =
    explicitProvider === undefined &&
    (web.provider !== undefined || Boolean(web.apiKey) || Boolean(web.endpoint));
  const endpointDefault =
    provider === "exa" ? "https://mcp.exa.ai/mcp" : "https://api.tavily.com/search";
  const writeWeb = async (patch: {
    provider?: "tavily" | "exa";
    endpoint?: string | null;
    apiKey?: string | null;
    numResults?: number | null;
  }) => {
    // 歧义配置下只有"选择 provider"和"清空 key/endpoint"能写：前者修好它，后者只会减少歧义。
    const reducesAmbiguity = patch.apiKey === null || patch.endpoint === null;
    if (needsProvider && !patch.provider && !reducesAmbiguity) {
      throw new Error(intl.formatMessage({ id: "settings.nek.web.providerRequired" }));
    }
    // 删掉凭据时不能顺手补一个 provider：那等于替用户猜服务商。
    const webPatch = needsProvider && !patch.provider ? patch : { provider, ...patch };
    await settings.patch(nestedSettingsPatch({ webSearch: webPatch }));
    setResult(null);
  };
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
      <SettingSelectField
        label={intl.formatMessage({ id: "settings.nek.web.provider" })}
        description={intl.formatMessage({
          id: needsProvider ? "settings.nek.web.providerRequired" : "settings.nek.web.providerHint",
        })}
        value={needsProvider ? "" : provider}
        options={[
          { value: "tavily", label: "Tavily" },
          { value: "exa", label: "Exa" },
        ]}
        onCommit={async (next) => {
          if (next !== "tavily" && next !== "exa")
            throw new Error(intl.formatMessage({ id: "settings.nek.web.providerRequired" }));
          // 已有凭据时不换服务商：把 Tavily 的 key 悄悄发给 Exa 是数据泄露，
          // 自动删掉用户填的 key 同样不行，只能要求先手动清空。
          if (!needsProvider && next !== provider && hasCredentials) {
            throw new Error(intl.formatMessage({ id: "settings.nek.web.clearBeforeSwitch" }));
          }
          await writeWeb({ provider: next });
        }}
      />
      <SecretSettingField
        label={intl.formatMessage({ id: "settings.nek.web.apiKey" })}
        description={intl.formatMessage({
          id:
            provider === "tavily"
              ? "settings.nek.web.tavilyApiKeyHint"
              : "settings.nek.web.apiKeyHint",
        })}
        value={web.apiKey ?? ""}
        placeholder={intl.formatMessage({ id: "settings.nek.web.apiKeyPlaceholder" })}
        onCommit={(apiKey) => writeWeb({ apiKey: apiKey || null })}
      />
      <SettingNumberField
        label={intl.formatMessage({ id: "settings.nek.web.numResults" })}
        integer
        min={1}
        max={20}
        unit={intl.formatMessage({ id: "settings.nek.unit.count" })}
        value={web.numResults ?? defaults.numResults ?? 8}
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
          disabled={!on || needsProvider}
          disabledReason={intl.formatMessage({
            id: needsProvider
              ? "settings.nek.web.providerRequired"
              : "settings.nek.web.testDisabled",
          })}
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
          value={web.endpoint ?? ""}
          placeholder={endpointDefault}
          defaultValue=""
          inputClassName="w-72 font-mono"
          validate={(value) =>
            value === "" || /^https?:\/\//.test(value)
              ? null
              : intl.formatMessage({ id: "settings.nek.provider.error.baseUrlInvalid" })
          }
          onCommit={(endpoint) =>
            writeWeb({
              endpoint: endpoint === "" || endpoint === endpointDefault ? null : endpoint,
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

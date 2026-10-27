/**
 * 默认模型：默认模型与默认思考等级（即时保存）；循环范围 `enabledModels`（对应 `/scoped-models`）：
 * 勾选、拖拽排序（Alt+↑/↓）、按服务商全选 / 全不选。
 */
import { XIcon } from "lucide-react";
import type { NekCatalogModel, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { IconButton } from "@/components/ui/icon-button.js";
import {
  SaveStatusIndicator,
  SettingRow,
  SettingSection,
  useInstantCommit,
} from "@/components/ui/setting-fields.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekQuery } from "../api/useNekQuery.js";
import {
  settingOrDefault,
  useNekSettingsDoc,
  type NekSettingsDocument,
} from "../api/settingsDocs.js";
import {
  findCatalogModel,
  formatModelRef,
  groupModelsByProvider,
  parseModelRef,
  supportedThinkingLevels,
} from "../lib/modelRef.js";
import { DocumentGate } from "../components/DocumentStatus.js";
import { ModelSelect, ThinkingLevelSelect } from "../components/modelControls.js";
import { NekPageFrame } from "../components/NekPageFrame.js";
import { SortableList } from "../components/SortableList.js";

function DefaultModelFields({
  settings,
  models,
}: {
  settings: NekSettingsDocument;
  models: readonly NekCatalogModel[];
}) {
  const { intl } = useZCodeIntl();
  const values = settings.data?.values ?? {};
  const currentRef =
    values.defaultProvider && values.defaultModel
      ? formatModelRef(values.defaultProvider, values.defaultModel)
      : undefined;
  const modelCommit = useInstantCommit<string | undefined>(currentRef, async (ref) => {
    const parsed = ref ? parseModelRef(ref) : null;
    await settings.patch(
      parsed
        ? { defaultProvider: parsed.provider, defaultModel: parsed.id }
        : { defaultProvider: null, defaultModel: null },
    );
  });
  const level = settingOrDefault(settings.data, (view) => view.defaultThinkingLevel);
  const levelCommit = useInstantCommit<NekThinkingLevel | undefined>(
    values.defaultThinkingLevel,
    (next) => settings.patch({ defaultThinkingLevel: next ?? null }),
  );
  const levels = supportedThinkingLevels(findCatalogModel(models, modelCommit.displayValue));
  return (
    <SettingSection title={intl.formatMessage({ id: "settings.nek.defaultModel.title" })}>
      <SettingRow
        label={intl.formatMessage({ id: "settings.nek.defaultModel.model" })}
        description={intl.formatMessage({ id: "settings.nek.defaultModel.modelHint" })}
        state={modelCommit.action.state}
      >
        <ModelSelect
          ariaLabel={intl.formatMessage({ id: "settings.nek.defaultModel.model" })}
          value={modelCommit.displayValue}
          models={models}
          onChange={modelCommit.commit}
        />
      </SettingRow>
      <SettingRow
        label={intl.formatMessage({ id: "settings.nek.defaultModel.thinking" })}
        description={intl.formatMessage(
          { id: "settings.nek.defaultModel.thinkingHint" },
          { level: level ? intl.formatMessage({ id: `settings.nek.thinking.${level}` }) : "—" },
        )}
        state={levelCommit.action.state}
      >
        <ThinkingLevelSelect
          ariaLabel={intl.formatMessage({ id: "settings.nek.defaultModel.thinking" })}
          value={levelCommit.displayValue}
          levels={levels}
          unsetLabel={intl.formatMessage({ id: "settings.nek.common.useDefault" })}
          onChange={levelCommit.commit}
        />
      </SettingRow>
    </SettingSection>
  );
}

function ScopedModels({
  settings,
  models,
}: {
  settings: NekSettingsDocument;
  models: readonly NekCatalogModel[];
}) {
  const { intl } = useZCodeIntl();
  const enabled = settings.data?.values.enabledModels ?? [];
  const save = useAsyncAction((next: string[]) =>
    settings.patch({ enabledModels: next.length > 0 ? next : null }),
  );
  const update = (next: string[]) => void save.run(next);
  const toggle = (refs: string[], checked: boolean) => {
    const current = new Set(enabled);
    update(
      checked
        ? [...enabled, ...refs.filter((ref) => !current.has(ref))]
        : enabled.filter((ref) => !refs.includes(ref)),
    );
  };
  const known = new Map(models.map((model) => [formatModelRef(model.provider, model.id), model]));
  return (
    <SettingSection
      title={
        <span className="flex items-center gap-2">
          {intl.formatMessage({ id: "settings.nek.scoped.title" })}
          <SaveStatusIndicator state={save.state} />
        </span>
      }
      description={intl.formatMessage({ id: "settings.nek.scoped.description" })}
    >
      {save.state.status === "error" ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {save.state.message}
        </p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-card-border bg-card p-3">
          <h4 className="text-ui-sm font-medium text-foreground">
            {intl.formatMessage({ id: "settings.nek.scoped.selected" }, { count: enabled.length })}
          </h4>
          {enabled.length === 0 ? (
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.nek.scoped.allModels" })}
            </p>
          ) : (
            <SortableList
              ids={enabled}
              dragLabel={intl.formatMessage({ id: "settings.nek.model.dragLabel" })}
              onReorder={update}
              renderItem={(ref) => (
                <div className="flex items-center gap-2 py-1">
                  <span className="min-w-0 flex-1 truncate font-mono text-ui-sm">{ref}</span>
                  {!known.has(ref) ? (
                    <span className="text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: "settings.nek.scoped.pattern" })}
                    </span>
                  ) : null}
                  <IconButton
                    size="icon-sm"
                    label={intl.formatMessage({ id: "settings.nek.scoped.remove" })}
                    onClick={() => toggle([ref], false)}
                  >
                    <XIcon />
                  </IconButton>
                </div>
              )}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-card-border bg-card p-3">
          {groupModelsByProvider(models).map((group) => {
            const refs = group.models.map((model) => formatModelRef(model.provider, model.id));
            const allChecked = refs.every((ref) => enabled.includes(ref));
            return (
              <fieldset key={group.provider} className="flex flex-col gap-1">
                <legend className="flex w-full items-center justify-between">
                  <span className="text-ui-sm font-medium text-foreground">{group.provider}</span>
                  <Button variant="ghost" size="xs" onClick={() => toggle(refs, !allChecked)}>
                    {intl.formatMessage({
                      id: allChecked
                        ? "settings.nek.scoped.selectNone"
                        : "settings.nek.scoped.selectAll",
                    })}
                  </Button>
                </legend>
                {group.models.map((model) => {
                  const ref = formatModelRef(model.provider, model.id);
                  return (
                    <label
                      key={ref}
                      className="flex items-center gap-2 rounded-md px-1 py-0.5 text-ui-sm hover:bg-hover"
                    >
                      <Checkbox
                        checked={enabled.includes(ref)}
                        onCheckedChange={(checked) => toggle([ref], checked === true)}
                      />
                      <span className="min-w-0 flex-1 truncate">{model.name || model.id}</span>
                      <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
                        {model.id}
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            );
          })}
        </div>
      </div>
    </SettingSection>
  );
}

export function DefaultModelPage() {
  const { intl } = useZCodeIntl();
  const settings = useNekSettingsDoc();
  const available = useNekQuery((api, target) => api.listAvailableModels(target), []);
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.defaultModel.pageDescription" })}
      documents={[settings]}
    >
      <DocumentGate documents={[settings, available]}>
        {() => (
          <div className="flex flex-col gap-8">
            <DefaultModelFields settings={settings} models={available.data ?? []} />
            <ScopedModels settings={settings} models={available.data ?? []} />
          </div>
        )}
      </DocumentGate>
    </NekPageFrame>
  );
}

/**
 * 默认模型：默认模型与默认思考等级（即时保存）；循环范围 `enabledModels`（对应 `/scoped-models`）：
 * 勾选、拖拽排序（Alt+↑/↓）、按服务商全选 / 全不选。
 */
import type { NekCatalogModel, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import { SettingRow, SettingSection, useInstantCommit } from "@/components/ui/setting-fields.js";
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
  parseModelRef,
  supportedThinkingLevels,
} from "../lib/modelRef.js";
import { DocumentGate } from "../components/DocumentStatus.js";
import { ModelSelect, ThinkingLevelSelect } from "../components/modelControls.js";
import { NekPageFrame } from "../components/NekPageFrame.js";
import { ScopedModelsSection } from "./ScopedModelsSection.js";

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
            <ScopedModelsSection />
          </div>
        )}
      </DocumentGate>
    </NekPageFrame>
  );
}

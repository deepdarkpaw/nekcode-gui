/**
 * 压缩：自动压缩开关；压缩模型（跟随主模型 / 指定）；思考等级只列所选模型支持的；
 * 预留与保留 tokens 及触发条件说明；按模型覆盖（高级）；内容折叠 8 项（高级，可恢复默认）；
 * 分支摘要；不兼容组合立即提示（nek 遇到会直接报错，不会退回主模型）。
 */
import { useState } from "react";
import { AlertTriangleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { NekCatalogModel, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import { nekSettingsIssues } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import {
  SettingAdvancedGroup,
  SettingRow,
  SettingSection,
  SettingSwitchField,
  useInstantCommit,
} from "@/components/ui/setting-fields.js";
import { SettingNumberField } from "@/components/ui/setting-text-field.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTokens } from "@/lib/displayFormat.js";
import { useNekQuery } from "../api/useNekQuery.js";
import { useNekSettingsDoc, type NekSettingsDocument } from "../api/settingsDocs.js";
import { checkCompaction, mainModelRef, type CompactionIssue } from "../lib/compactionChecks.js";
import { findCatalogModel, supportedThinkingLevels } from "../lib/modelRef.js";
import {
  isPlainObject,
  nestedSettingsPatch,
  type NestedSettingsPatch,
} from "../lib/settingsPatch.js";
import { CompactionRepairs, ContentSettings } from "./compaction/ContentSettings.js";
import { DocumentGate } from "../components/DocumentStatus.js";
import { ModelSelect, ThinkingLevelSelect } from "../components/modelControls.js";
import { NekPageFrame } from "../components/NekPageFrame.js";

type Compaction = NonNullable<NestedSettingsPatch["compaction"]>;

function IssueList({ issues }: { issues: readonly CompactionIssue[] }) {
  const { intl } = useZCodeIntl();
  if (issues.length === 0) return null;
  return (
    <ul role="alert" className="flex flex-col gap-1">
      {issues.map((issue) => (
        <li
          key={issue.kind}
          className={cn(
            "flex items-start gap-2 rounded-lg px-3 py-2 text-ui-sm",
            issue.severity === "error"
              ? "bg-destructive/10 text-destructive"
              : "bg-warning/10 text-foreground",
          )}
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {intl.formatMessage(
            { id: `settings.nek.compaction.issue.${issue.kind}` },
            {
              model: "model" in issue ? issue.model : "",
              level: "level" in issue ? issue.level : "",
              reserve: "reserve" in issue ? formatTokens(issue.reserve) : "",
              context: "contextWindow" in issue ? formatTokens(issue.contextWindow) : "",
              main: "mainContextWindow" in issue ? formatTokens(issue.mainContextWindow) : "",
            },
          )}
        </li>
      ))}
    </ul>
  );
}

function useCompactionWriter(settings: NekSettingsDocument) {
  return (compaction: Compaction) => settings.patch(nestedSettingsPatch({ compaction }));
}

/** 数字字段的写入：等于默认值时删除键（恢复默认）。 */
function numberOrNull(value: number, fallback: number | undefined): number | null {
  return value === fallback ? null : value;
}

function ModelSection({
  settings,
  models,
}: {
  settings: NekSettingsDocument;
  models: readonly NekCatalogModel[];
}) {
  const { intl } = useZCodeIntl();
  const write = useCompactionWriter(settings);
  const values = settings.data?.values ?? {};
  const defaults = settings.data?.defaults ?? {};
  const compaction = values.compaction ?? {};
  const mainRef = mainModelRef(values);
  const issues = nekSettingsIssues({ compaction });
  const model = issues.some(({ path }) => path[1] === "model") ? undefined : compaction.model;
  const level = issues.some(({ path }) => path[1] === "thinkingLevel")
    ? undefined
    : compaction.thinkingLevel;
  const modelCommit = useInstantCommit(model, (next) => write({ model: next ?? null }));
  const levelCommit = useInstantCommit<NekThinkingLevel | undefined>(level, (thinkingLevel) =>
    write({ thinkingLevel: thinkingLevel ?? null }),
  );
  const chosen = findCatalogModel(models, modelCommit.displayValue ?? mainRef);
  const reserve = compaction.reserveTokens ?? defaults.compaction?.reserveTokens ?? 0;
  const keep = compaction.keepRecentTokens ?? defaults.compaction?.keepRecentTokens ?? 0;
  const override = mainRef === undefined ? undefined : compaction.modelOverrides?.[mainRef];
  const effectiveReserve = override?.reserveTokens ?? reserve;
  const effectiveKeep = override?.keepRecentTokens ?? keep;
  const mainContext = findCatalogModel(models, mainRef)?.contextWindow;
  return (
    <SettingSection title={intl.formatMessage({ id: "settings.nek.compaction.title" })}>
      <SettingSwitchField
        label={intl.formatMessage({ id: "settings.nek.compaction.enabled" })}
        description={intl.formatMessage({ id: "settings.nek.compaction.enabledHint" })}
        value={compaction.enabled ?? defaults.compaction?.enabled ?? true}
        onCommit={(enabled) => write({ enabled })}
      />
      <SettingRow
        label={intl.formatMessage({ id: "settings.nek.compaction.model" })}
        description={intl.formatMessage(
          { id: "settings.nek.compaction.modelHint" },
          { main: mainRef ?? "—" },
        )}
        state={modelCommit.action.state}
      >
        <ModelSelect
          ariaLabel={intl.formatMessage({ id: "settings.nek.compaction.model" })}
          value={modelCommit.displayValue}
          models={models}
          unsetLabel={intl.formatMessage({ id: "settings.nek.compaction.followMain" })}
          onChange={modelCommit.commit}
        />
      </SettingRow>
      <SettingRow
        label={intl.formatMessage({ id: "settings.nek.compaction.thinking" })}
        description={intl.formatMessage({ id: "settings.nek.compaction.thinkingHint" })}
        state={levelCommit.action.state}
      >
        <ThinkingLevelSelect
          ariaLabel={intl.formatMessage({ id: "settings.nek.compaction.thinking" })}
          value={levelCommit.displayValue}
          levels={supportedThinkingLevels(chosen)}
          unsetLabel={intl.formatMessage({ id: "settings.nek.common.useDefault" })}
          onChange={levelCommit.commit}
        />
      </SettingRow>
      <SettingNumberField
        label={intl.formatMessage({ id: "settings.nek.compaction.reserve" })}
        description={intl.formatMessage({ id: "settings.nek.compaction.reserveHint" })}
        unit="tokens"
        integer
        min={0}
        max={Number.MAX_SAFE_INTEGER}
        value={reserve}
        defaultValue={defaults.compaction?.reserveTokens}
        onCommit={(value) =>
          write({ reserveTokens: numberOrNull(value, defaults.compaction?.reserveTokens) })
        }
      />
      <SettingNumberField
        label={intl.formatMessage({ id: "settings.nek.compaction.keepRecent" })}
        description={intl.formatMessage({ id: "settings.nek.compaction.keepRecentHint" })}
        unit="tokens"
        integer
        min={0}
        max={Number.MAX_SAFE_INTEGER}
        value={keep}
        defaultValue={defaults.compaction?.keepRecentTokens}
        onCommit={(value) =>
          write({ keepRecentTokens: numberOrNull(value, defaults.compaction?.keepRecentTokens) })
        }
      />
      {issues.length === 0 ? (
        <>
          <p className="rounded-lg bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
            {mainContext
              ? intl.formatMessage(
                  { id: "settings.nek.compaction.trigger" },
                  {
                    context: formatTokens(mainContext),
                    reserve: formatTokens(effectiveReserve),
                    threshold: formatTokens(mainContext - effectiveReserve),
                    keep: formatTokens(effectiveKeep),
                  },
                )
              : intl.formatMessage(
                  { id: "settings.nek.compaction.triggerGeneric" },
                  { reserve: formatTokens(reserve), keep: formatTokens(keep) },
                )}
          </p>
          <IssueList
            issues={checkCompaction(
              { ...values, compaction: { ...compaction, reserveTokens: effectiveReserve } },
              models,
              defaults,
            )}
          />
        </>
      ) : null}
    </SettingSection>
  );
}

function OverridesSection({
  settings,
  models,
}: {
  settings: NekSettingsDocument;
  models: readonly NekCatalogModel[];
}) {
  const { intl } = useZCodeIntl();
  const write = useCompactionWriter(settings);
  const [adding, setAdding] = useState<string | undefined>(undefined);
  const defaults = settings.data?.values.compaction ?? {};
  const fallback = settings.data?.defaults.compaction ?? {};
  const overrides = isPlainObject(defaults.modelOverrides) ? defaults.modelOverrides : {};
  const reserveDefault = defaults.reserveTokens ?? fallback.reserveTokens ?? 0;
  const keepDefault = defaults.keepRecentTokens ?? fallback.keepRecentTokens ?? 0;
  return (
    <SettingAdvancedGroup title={intl.formatMessage({ id: "settings.nek.compaction.overrides" })}>
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.nek.compaction.overridesHint" })}
      </p>
      {Object.entries(overrides).map(([ref, override]) => (
        <div
          key={ref}
          className="flex flex-col rounded-xl border border-card-border bg-card px-3 py-1"
        >
          <div className="flex items-center justify-between py-1">
            <span className="font-mono text-ui-sm text-foreground">{ref}</span>
            <IconButton
              size="icon-sm"
              label={intl.formatMessage({ id: "settings.nek.compaction.removeOverride" })}
              onClick={() => void write({ modelOverrides: { [ref]: null } })}
            >
              <Trash2Icon />
            </IconButton>
          </div>
          <SettingNumberField
            label={intl.formatMessage({ id: "settings.nek.compaction.reserve" })}
            unit="tokens"
            integer
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            value={override?.reserveTokens ?? reserveDefault}
            defaultValue={reserveDefault}
            onCommit={(reserveTokens) =>
              write({
                modelOverrides: {
                  [ref]: { reserveTokens: numberOrNull(reserveTokens, reserveDefault) },
                },
              })
            }
          />
          <SettingNumberField
            label={intl.formatMessage({ id: "settings.nek.compaction.keepRecent" })}
            unit="tokens"
            integer
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            value={override?.keepRecentTokens ?? keepDefault}
            defaultValue={keepDefault}
            onCommit={(keepRecentTokens) =>
              write({
                modelOverrides: {
                  [ref]: { keepRecentTokens: numberOrNull(keepRecentTokens, keepDefault) },
                },
              })
            }
          />
        </div>
      ))}
      <div className="flex items-center gap-2">
        <ModelSelect
          ariaLabel={intl.formatMessage({ id: "settings.nek.compaction.addOverrideModel" })}
          value={adding}
          models={models.filter((model) => !(`${model.provider}/${model.id}` in overrides))}
          onChange={setAdding}
        />
        <Button
          variant="outline"
          disabled={!adding}
          onClick={() => {
            if (adding) {
              void write({
                modelOverrides: {
                  [adding]: { reserveTokens: defaults.reserveTokens ?? fallback.reserveTokens },
                },
              });
              setAdding(undefined);
            }
          }}
        >
          <PlusIcon aria-hidden="true" />
          {intl.formatMessage({ id: "settings.nek.compaction.addOverride" })}
        </Button>
      </div>
    </SettingAdvancedGroup>
  );
}

function BranchSummarySection({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const values = settings.data?.values.branchSummary ?? {};
  const defaults = settings.data?.defaults.branchSummary ?? {};
  const write = (branchSummary: NonNullable<NestedSettingsPatch["branchSummary"]>) =>
    settings.patch(nestedSettingsPatch({ branchSummary }));
  return (
    <SettingSection
      title={intl.formatMessage({ id: "settings.nek.branchSummary.title" })}
      description={intl.formatMessage({ id: "settings.nek.branchSummary.description" })}
    >
      <SettingNumberField
        label={intl.formatMessage({ id: "settings.nek.compaction.reserve" })}
        unit="tokens"
        value={values.reserveTokens ?? defaults.reserveTokens ?? 0}
        defaultValue={defaults.reserveTokens}
        onCommit={(value) => write({ reserveTokens: numberOrNull(value, defaults.reserveTokens) })}
      />
      <SettingSwitchField
        label={intl.formatMessage({ id: "settings.nek.branchSummary.skipPrompt" })}
        description={intl.formatMessage({ id: "settings.nek.branchSummary.skipPromptHint" })}
        value={values.skipPrompt ?? defaults.skipPrompt ?? false}
        onCommit={(skipPrompt) => write({ skipPrompt })}
      />
    </SettingSection>
  );
}

export function CompactionPage() {
  const { intl } = useZCodeIntl();
  const settings = useNekSettingsDoc();
  const available = useNekQuery((api, target) => api.listAvailableModels(target), []);
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.compaction.pageDescription" })}
      documents={[settings]}
    >
      <DocumentGate documents={[settings, available]}>
        {() => (
          <div className="flex flex-col gap-8">
            <div className="flex flex-col gap-2">
              <CompactionRepairs settings={settings} />
              <ModelSection settings={settings} models={available.data ?? []} />
              <OverridesSection settings={settings} models={available.data ?? []} />
              <ContentSettings settings={settings} />
            </div>
            <BranchSummarySection settings={settings} />
          </div>
        )}
      </DocumentGate>
    </NekPageFrame>
  );
}

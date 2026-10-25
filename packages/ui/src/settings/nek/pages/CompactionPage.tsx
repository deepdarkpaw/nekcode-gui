/**
 * 压缩：自动压缩开关；压缩模型（跟随主模型 / 指定）；思考等级只列所选模型支持的；
 * 预留与保留 tokens 及触发条件说明；按模型覆盖（高级）；内容折叠 8 项（高级，可恢复默认）；
 * 分支摘要；不兼容组合立即提示（nek 遇到会直接报错，不会退回主模型）。
 */
import { useState } from "react";
import { AlertTriangleIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type {
  NekCatalogModel,
  NekCompactionContentSettings,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
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
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTokens } from "@/lib/displayFormat.js";
import { useNekQuery } from "../api/useNekQuery.js";
import { useNekSettingsDoc, type NekSettingsDocument } from "../api/settingsDocs.js";
import { checkCompaction, mainModelRef, type CompactionIssue } from "../lib/compactionChecks.js";
import { findCatalogModel, supportedThinkingLevels } from "../lib/modelRef.js";
import { nestedSettingsPatch, type NestedSettingsPatch } from "../lib/settingsPatch.js";
import { DocumentGate } from "../components/DocumentStatus.js";
import { ModelSelect, ThinkingLevelSelect } from "../components/modelControls.js";
import { NekPageFrame } from "../components/NekPageFrame.js";

type Compaction = NonNullable<NestedSettingsPatch["compaction"]>;

const CONTENT_NUMBER_FIELDS = [
  ["thinkingMaxChars", "chars"],
  ["thinkingTotalMaxChars", "chars"],
  ["toolResultMaxChars", "chars"],
  ["toolErrorMaxChars", "chars"],
  ["toolArgumentMaxChars", "chars"],
  ["protectedRecentTokens", "tokens"],
  ["protectedToolResults", "count"],
] as const;

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
  const modelCommit = useInstantCommit<string | undefined>(compaction.model, (model) =>
    write({ model: model ?? null }),
  );
  const levelCommit = useInstantCommit<NekThinkingLevel | undefined>(
    compaction.thinkingLevel,
    (thinkingLevel) => write({ thinkingLevel: thinkingLevel ?? null }),
  );
  const chosen = findCatalogModel(models, modelCommit.displayValue ?? mainRef);
  const reserve = compaction.reserveTokens ?? defaults.compaction?.reserveTokens ?? 0;
  const keep = compaction.keepRecentTokens ?? defaults.compaction?.keepRecentTokens ?? 0;
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
        value={keep}
        defaultValue={defaults.compaction?.keepRecentTokens}
        onCommit={(value) =>
          write({ keepRecentTokens: numberOrNull(value, defaults.compaction?.keepRecentTokens) })
        }
      />
      <p className="rounded-lg bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
        {mainContext
          ? intl.formatMessage(
              { id: "settings.nek.compaction.trigger" },
              {
                context: formatTokens(mainContext),
                reserve: formatTokens(reserve),
                threshold: formatTokens(Math.max(0, mainContext - reserve)),
                keep: formatTokens(keep),
              },
            )
          : intl.formatMessage(
              { id: "settings.nek.compaction.triggerGeneric" },
              { reserve: formatTokens(reserve), keep: formatTokens(keep) },
            )}
      </p>
      <IssueList issues={checkCompaction(values, models, defaults)} />
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
  const overrides = settings.data?.values.compaction?.modelOverrides ?? {};
  const defaults = settings.data?.values.compaction ?? {};
  const fallback = settings.data?.defaults.compaction ?? {};
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
            value={override.reserveTokens ?? defaults.reserveTokens ?? fallback.reserveTokens ?? 0}
            onCommit={(reserveTokens) => write({ modelOverrides: { [ref]: { reserveTokens } } })}
          />
          <SettingNumberField
            label={intl.formatMessage({ id: "settings.nek.compaction.keepRecent" })}
            unit="tokens"
            integer
            min={0}
            value={
              override.keepRecentTokens ??
              defaults.keepRecentTokens ??
              fallback.keepRecentTokens ??
              0
            }
            onCommit={(keepRecentTokens) =>
              write({ modelOverrides: { [ref]: { keepRecentTokens } } })
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

function PruneSwitchRow({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const write = useCompactionWriter(settings);
  const explicit = settings.data?.values.compaction?.content?.pruneToolResults;
  const fallback = settings.data?.defaults.compaction?.content?.pruneToolResults ?? true;
  const commit = useInstantCommit<boolean>(explicit ?? fallback, (pruneToolResults) =>
    write({
      content: { pruneToolResults: pruneToolResults === fallback ? null : pruneToolResults },
    }),
  );
  return (
    <SettingRow
      label={intl.formatMessage({ id: "settings.nek.compaction.content.pruneToolResults" })}
      description={intl.formatMessage({
        id: "settings.nek.compaction.content.pruneToolResultsHint",
      })}
      state={commit.action.state}
      trailing={
        explicit !== undefined && explicit !== fallback ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void write({ content: { pruneToolResults: null } })}
          >
            {intl.formatMessage({ id: "ui.setting.resetToDefault" })}
          </Button>
        ) : null
      }
    >
      <Switch
        checked={commit.displayValue}
        onCheckedChange={commit.commit}
        aria-label={intl.formatMessage({ id: "settings.nek.compaction.content.pruneToolResults" })}
      />
    </SettingRow>
  );
}

function ContentSection({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const write = useCompactionWriter(settings);
  const content: NekCompactionContentSettings = settings.data?.values.compaction?.content ?? {};
  const defaults: NekCompactionContentSettings = settings.data?.defaults.compaction?.content ?? {};
  return (
    <SettingAdvancedGroup
      title={intl.formatMessage({ id: "settings.nek.compaction.content.title" })}
    >
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.nek.compaction.content.hint" })}
      </p>
      {CONTENT_NUMBER_FIELDS.map(([field, unit]) => (
        <SettingNumberField
          key={field}
          label={intl.formatMessage({ id: `settings.nek.compaction.content.${field}` })}
          unit={intl.formatMessage({ id: `settings.nek.unit.${unit}` })}
          integer
          min={0}
          value={content[field] ?? defaults[field] ?? 0}
          defaultValue={defaults[field]}
          onCommit={(value) =>
            write({ content: { [field]: numberOrNull(value, defaults[field]) } })
          }
        />
      ))}
      <PruneSwitchRow settings={settings} />
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
        integer
        min={0}
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
              <ModelSection settings={settings} models={available.data ?? []} />
              <OverridesSection settings={settings} models={available.data ?? []} />
              <ContentSection settings={settings} />
            </div>
            <BranchSummarySection settings={settings} />
          </div>
        )}
      </DocumentGate>
    </NekPageFrame>
  );
}

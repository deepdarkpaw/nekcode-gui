import { useState } from "react";
import type { NekSettingsPatch } from "@zcode/shared/nek-protocol";
import { NEK_COMPACTION_CONTENT_MINIMUMS, nekSettingsIssues } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { SettingNumberField } from "@/components/ui/setting-text-field.js";
import {
  SettingAdvancedGroup,
  SettingRow,
  useInstantCommit,
} from "@/components/ui/setting-fields.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NekSettingsDocument } from "../../api/settingsDocs.js";
import { DiagnosticsList } from "../../components/DocumentStatus.js";
import { nestedSettingsPatch } from "../../lib/settingsPatch.js";

const CONTENT_NUMBER_FIELDS = [
  ["thinkingMaxChars", "chars"],
  ["thinkingTotalMaxChars", "chars"],
  ["toolResultMaxChars", "chars"],
  ["toolErrorMaxChars", "chars"],
  ["toolArgumentMaxChars", "chars"],
  ["protectedRecentTokens", "tokens"],
  ["protectedToolResults", "count"],
] as const;

function PruneSwitchRow({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const explicit = settings.data?.values.compaction?.content?.pruneToolResults;
  const fallback = settings.data?.defaults.compaction?.content?.pruneToolResults ?? true;
  const write = (value: boolean | null) =>
    settings.patch(nestedSettingsPatch({ compaction: { content: { pruneToolResults: value } } }));
  const commit = useInstantCommit(typeof explicit === "boolean" ? explicit : fallback, (value) =>
    write(value === fallback ? null : value),
  );
  const label = intl.formatMessage({ id: "settings.nek.compaction.content.pruneToolResults" });
  return (
    <SettingRow
      label={label}
      description={intl.formatMessage({
        id: "settings.nek.compaction.content.pruneToolResultsHint",
      })}
      state={commit.action.state}
      trailing={
        typeof explicit === "boolean" && explicit !== fallback ? (
          <AsyncButton variant="ghost" size="sm" onClick={() => write(null)}>
            {intl.formatMessage({ id: "ui.setting.resetToDefault" })}
          </AsyncButton>
        ) : null
      }
    >
      <Switch checked={commit.displayValue} onCheckedChange={commit.commit} aria-label={label} />
    </SettingRow>
  );
}

export function ContentSettings({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const content = settings.data?.values.compaction?.content ?? {};
  const defaults = settings.data?.defaults.compaction?.content ?? {};
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
          min={NEK_COMPACTION_CONTENT_MINIMUMS[field]}
          max={Number.MAX_SAFE_INTEGER}
          value={content[field] === undefined ? (defaults[field] ?? 0) : content[field]}
          defaultValue={defaults[field]}
          onCommit={(value) =>
            settings.patch(
              nestedSettingsPatch({
                compaction: { content: { [field]: value === defaults[field] ? null : value } },
              }),
            )
          }
        />
      ))}
      <PruneSwitchRow settings={settings} />
    </SettingAdvancedGroup>
  );
}

type Issue = ReturnType<typeof nekSettingsIssues>[number];

function removeSetting(path: string[]): NekSettingsPatch {
  return path.reduceRight<Record<string, unknown> | null>(
    (child, key) => ({ [key]: child }),
    null,
  ) as NekSettingsPatch;
}

/** Repair by deleting only the invalid value, even when siblings are also invalid. */
export function CompactionRepairs({ settings }: { settings: NekSettingsDocument }) {
  const { intl } = useZCodeIntl();
  const data = settings.data;
  const [pending, setPending] = useState<Issue>();
  if (!data) return null;
  const label = intl.formatMessage({ id: "ui.setting.resetToDefault" });
  const issues = nekSettingsIssues({ compaction: data.values.compaction });
  const pendingKey = pending ? JSON.stringify(pending.path) : undefined;
  // Keep the action mounted across the optimistic deletion so a failed write is visible and retryable.
  if (pending && !issues.some(({ path }) => JSON.stringify(path) === pendingKey)) {
    issues.push(pending);
  }
  return issues.map((issue) => {
    const key = JSON.stringify(issue.path);
    const field = issue.path.join(".");
    return (
      <div key={key} className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <DiagnosticsList
            diagnostics={[
              { file: data.path, severity: "error", message: `${field}: ${issue.message}` },
            ]}
          />
        </div>
        <AsyncButton
          variant="ghost"
          size="sm"
          aria-label={label}
          disabled={pendingKey !== undefined && pendingKey !== key}
          disabledReason={intl.formatMessage({ id: "ui.action.busy" })}
          onClick={async () => {
            setPending(issue);
            try {
              await settings.patch(removeSetting(issue.path));
            } finally {
              setPending(undefined);
            }
          }}
        >
          {label}
        </AsyncButton>
      </div>
    );
  });
}

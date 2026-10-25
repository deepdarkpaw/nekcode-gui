/**
 * 模型相关控件：模型下拉（按服务商分组）、思考等级下拉与徽标。
 */
import type { NekCatalogModel, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatModelRef, groupModelsByProvider } from "../lib/modelRef.js";

export const UNSET_VALUE = "__nek_unset__";

/** 模型下拉；`unsetLabel` 提供"跟随主模型 / 继承"之类的空选项。值不在列表中时仍显示原值（标注缺失）。 */
export function ModelSelect({
  id,
  value,
  models,
  onChange,
  unsetLabel,
  disabled,
  invalid,
  className,
  ariaLabel,
}: {
  id?: string;
  value: string | undefined;
  models: readonly NekCatalogModel[];
  onChange: (value: string | undefined) => void;
  unsetLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const groups = groupModelsByProvider(models);
  const known = value
    ? models.some((model) => formatModelRef(model.provider, model.id) === value)
    : true;
  return (
    <Select
      value={value ?? (unsetLabel ? UNSET_VALUE : undefined)}
      disabled={disabled}
      onValueChange={(next) => onChange(next === UNSET_VALUE ? undefined : next)}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || !known || undefined}
        className={cn("w-72 min-w-0", className)}
      >
        <SelectValue
          placeholder={intl.formatMessage({ id: "settings.nek.model.selectPlaceholder" })}
        />
      </SelectTrigger>
      <SelectContent>
        {unsetLabel ? (
          <>
            <SelectItem value={UNSET_VALUE}>{unsetLabel}</SelectItem>
            <SelectSeparator />
          </>
        ) : null}
        {!known && value ? (
          <SelectItem value={value}>
            <span className="font-mono">{value}</span>
            <span className="ml-2 text-destructive">
              {intl.formatMessage({ id: "settings.nek.model.missing" })}
            </span>
          </SelectItem>
        ) : null}
        {groups.map((group) => (
          <SelectGroup key={group.provider}>
            <SelectLabel>{group.provider}</SelectLabel>
            {group.models.map((model) => (
              <SelectItem key={model.id} value={formatModelRef(model.provider, model.id)}>
                <span className="truncate">{model.name || model.id}</span>
                {model.name && model.name !== model.id ? (
                  <span className="ml-2 font-mono text-ui-xs text-foreground-subtlest">
                    {model.id}
                  </span>
                ) : null}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

export function thinkingLevelLabel(
  intl: { formatMessage: (d: { id: string }) => string },
  level: NekThinkingLevel,
) {
  return intl.formatMessage({ id: `settings.nek.thinking.${level}` });
}

/** 思考等级下拉；`unsetLabel` 提供"跟随默认"空选项。 */
export function ThinkingLevelSelect({
  id,
  value,
  levels,
  onChange,
  unsetLabel,
  disabled,
  invalid,
  ariaLabel,
}: {
  id?: string;
  value: NekThinkingLevel | undefined;
  levels: readonly NekThinkingLevel[];
  onChange: (value: NekThinkingLevel | undefined) => void;
  unsetLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const unsupported = value !== undefined && !levels.includes(value);
  return (
    <Select
      value={value ?? (unsetLabel ? UNSET_VALUE : undefined)}
      disabled={disabled}
      onValueChange={(next) =>
        onChange(next === UNSET_VALUE ? undefined : (next as NekThinkingLevel))
      }
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || unsupported || undefined}
        className="w-44"
      >
        <SelectValue
          placeholder={intl.formatMessage({ id: "settings.nek.thinking.placeholder" })}
        />
      </SelectTrigger>
      <SelectContent>
        {unsetLabel ? <SelectItem value={UNSET_VALUE}>{unsetLabel}</SelectItem> : null}
        {unsupported && value ? (
          <SelectItem value={value}>
            {thinkingLevelLabel(intl, value)} ·{" "}
            {intl.formatMessage({ id: "settings.nek.thinking.unsupported" })}
          </SelectItem>
        ) : null}
        {levels.map((level) => (
          <SelectItem key={level} value={level}>
            {thinkingLevelLabel(intl, level)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ThinkingLevelBadges({ levels }: { levels: readonly NekThinkingLevel[] }) {
  const { intl } = useZCodeIntl();
  if (levels.length === 0) {
    return <span className="text-ui-sm text-foreground-subtlest">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {levels.map((level) => (
        <span
          key={level}
          className="rounded-sm bg-tag px-1.5 text-ui-xs leading-5 text-foreground-subtle"
        >
          {thinkingLevelLabel(intl, level)}
        </span>
      ))}
    </span>
  );
}

/**
 * 设置中心通用输入控件：分段控件、键值对编辑、tokens 数量输入、复制按钮。
 */
import { useEffect, useState, type ReactNode } from "react";
import { CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { ToggleGroup } from "radix-ui";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTokens } from "@/lib/displayFormat.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { useNekHostApi } from "../api/NekSettingsContext.js";
import { createKeyValueRow, duplicateKeyRowIds, type KeyValueRow } from "../lib/keyValue.js";
import { formatTokenCountDraft, parseTokenCount } from "../lib/tokenCount.js";

/** 分段控件：方向键在选项间移动，单选，不允许取消选择。 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  id,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <ToggleGroup.Root
      id={id}
      type="single"
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onValueChange={(next) => {
        if (next) {
          onChange(next as T);
        }
      }}
      className="inline-flex w-fit flex-wrap gap-0.5 rounded-lg bg-surface p-0.5"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className="h-7 rounded-md px-2.5 text-ui-base text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused/30 disabled:opacity-50 data-[state=on]:bg-background data-[state=on]:text-foreground"
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

/** 键值对编辑器（请求头、环境变量）。重复的键标红。 */
export function KeyValueEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  secretValues = false,
}: {
  rows: readonly KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  secretValues?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const duplicates = duplicateKeyRowIds(rows);
  const update = (id: string, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-1.5">
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            aria-label={keyPlaceholder}
            aria-invalid={duplicates.has(row.id) || undefined}
            placeholder={keyPlaceholder}
            value={row.key}
            className="w-2/5 font-mono"
            onChange={(event) => update(row.id, { key: event.target.value })}
          />
          <Input
            {...TECHNICAL_INPUT_ATTRIBUTES}
            aria-label={valuePlaceholder}
            type={secretValues ? "password" : "text"}
            placeholder={valuePlaceholder}
            value={row.value}
            className="min-w-0 flex-1 font-mono"
            onChange={(event) => update(row.id, { value: event.target.value })}
          />
          <IconButton
            size="icon-sm"
            label={intl.formatMessage({ id: "settings.nek.kv.remove" })}
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
          >
            <Trash2Icon />
          </IconButton>
        </div>
      ))}
      {duplicates.size > 0 ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "settings.nek.kv.duplicate" })}
        </p>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...rows, createKeyValueRow()])}
      >
        <PlusIcon aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}

/**
 * tokens 数量输入：接受 `200k` / `1M`；输入时在旁边预览解析结果。
 * 值为 undefined 表示未设置（显示占位默认值）。
 */
export function TokenCountInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
  className,
}: {
  id?: string;
  value: number | undefined;
  onChange: (value: number | undefined, draftValid: boolean) => void;
  placeholder?: number;
  invalid?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(() => formatTokenCountDraft(value));
  useEffect(() => {
    setDraft((current) =>
      parseTokenCount(current) === value ? current : formatTokenCountDraft(value),
    );
  }, [value]);
  const parsed = parseTokenCount(draft);
  const draftValid = draft.trim() === "" || parsed !== null;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Input
        {...TECHNICAL_INPUT_ATTRIBUTES}
        id={id}
        value={draft}
        inputMode="text"
        placeholder={placeholder === undefined ? undefined : formatTokenCountDraft(placeholder)}
        aria-invalid={invalid || !draftValid || undefined}
        className="w-32 font-mono"
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const nextParsed = parseTokenCount(next);
          onChange(nextParsed ?? undefined, next.trim() === "" || nextParsed !== null);
        }}
      />
      <span className="text-ui-sm text-foreground-subtle">
        {parsed !== null
          ? `${parsed.toLocaleString("en-US")} tokens · ${formatTokens(parsed)}`
          : null}
      </span>
    </div>
  );
}

/** 复制按钮：成功原位 ✓。 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const host = useNekHostApi();
  return (
    <AsyncButton
      size="icon-sm"
      variant="ghost"
      label={label}
      icon={<CopyIcon />}
      onClick={() => host.copyText(text)}
    />
  );
}

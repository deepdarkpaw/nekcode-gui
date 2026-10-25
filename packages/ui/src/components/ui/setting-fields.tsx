/**
 * 设置字段原语（交互规范 §7.2）——只关心交互，不关心存储：
 * 所有字段接收 `onCommit(value) => Promise<void>`，Promise 失败即视为保存失败。
 *
 * - 开关 / 下拉：选择后立即保存；保存中 → ✓ 淡出；失败回滚控件并显示原因；
 * - 文本 / 数字：见 setting-text-field.tsx；
 * - 分组标题 `SettingSection`，「高级」折叠分组 `SettingAdvancedGroup`（基于 Fold）。
 *
 * ```tsx
 * <SettingSection title={…}>
 *   <SettingSwitchField label={…} value={settings.autoCompact} onCommit={(v) => save({ autoCompact: v })} />
 *   <SettingAdvancedGroup>
 *     <SettingNumberField label={…} unit="s" value={timeout} defaultValue={30} onCommit={saveTimeout} />
 *   </SettingAdvancedGroup>
 * </SettingSection>
 * ```
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { CheckIcon, CircleAlertIcon, LoaderIcon } from "lucide-react";
import { cn } from "../lib/utils.js";
import { Switch } from "./switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";
import { Fold, FoldContent, FoldTrigger } from "./fold.js";
import { useAsyncAction, type AsyncActionHandle } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ASYNC_SUCCESS_FEEDBACK_MS, type AsyncActionState } from "@/lib/asyncAction.js";

/** 分组标题 + 内容。 */
export function SettingSection({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section data-slot="setting-section" className={cn("flex flex-col gap-2", className)}>
      <header className="flex flex-col gap-0.5">
        <h3 className="text-ui-base font-medium text-foreground">{title}</h3>
        {description ? <p className="text-ui-sm text-foreground-subtle">{description}</p> : null}
      </header>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  );
}

/** 「高级」折叠分组：默认折叠。可传 open/onOpenChange 接入 useFoldState 保持状态。 */
export function SettingAdvancedGroup({
  children,
  title,
  open,
  defaultOpen = false,
  onOpenChange,
}: {
  children: ReactNode;
  title?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Fold open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <FoldTrigger className="h-7 text-foreground-subtle hover:text-foreground">
        {title ?? intl.formatMessage({ id: "ui.setting.advanced" })}
      </FoldTrigger>
      <FoldContent>
        <div className="flex flex-col gap-1 pt-1">{children}</div>
      </FoldContent>
    </Fold>
  );
}

/** 保存状态：保存中 spinner；成功 ✓ 后淡出；失败警示图标（原因由 SettingRow 显示）。 */
export function SaveStatusIndicator({ state }: { state: AsyncActionState }) {
  const { intl } = useZCodeIntl();
  if (state.status === "pending") {
    return (
      <LoaderIcon
        className="size-3.5 animate-spin text-foreground-subtlest"
        aria-label={intl.formatMessage({ id: "ui.setting.saving" })}
      />
    );
  }
  if (state.status === "success") {
    const fadeSeconds = 0.4;
    return (
      <motion.span
        role="status"
        aria-label={intl.formatMessage({ id: "ui.setting.saved" })}
        className="inline-flex"
        initial={{ opacity: 1 }}
        animate={{ opacity: 0 }}
        transition={{
          delay: ASYNC_SUCCESS_FEEDBACK_MS / 1000 - fadeSeconds,
          duration: fadeSeconds,
        }}
      >
        <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
      </motion.span>
    );
  }
  if (state.status === "error") {
    return <CircleAlertIcon className="size-3.5 text-destructive" aria-hidden="true" />;
  }
  return null;
}

/** 一行设置：左侧标题/说明/错误，右侧状态 + 控件。 */
export function SettingRow({
  label,
  description,
  htmlFor,
  state,
  error,
  children,
  trailing,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  state?: AsyncActionState;
  /** 额外错误（如校验失败）；未提供时显示保存失败原因。 */
  error?: string | null;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  const message = error ?? (state?.status === "error" ? state.message : null);
  return (
    <div
      data-slot="setting-row"
      className={cn("flex min-w-0 items-start justify-between gap-4 py-2", className)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={htmlFor} className="text-ui-base text-foreground">
          {label}
        </label>
        {description ? <p className="text-ui-sm text-foreground-subtle">{description}</p> : null}
        {message ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {message}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {state ? <SaveStatusIndicator state={state} /> : null}
        {children}
        {trailing}
      </div>
    </div>
  );
}

interface InstantCommit<T> {
  /** 控件应显示的值：保存中/保存成功后为用户选择的值，失败回滚为 props 值。 */
  displayValue: T;
  action: AsyncActionHandle<[T]>;
  commit: (next: T) => void;
}

/**
 * 即时保存：乐观显示用户的选择；失败回滚到 props 值；成功后保持选择直到 props 跟上。
 */
export function useInstantCommit<T>(
  value: T,
  onCommit: (value: T) => Promise<void>,
): InstantCommit<T> {
  const [optimistic, setOptimistic] = useState<{ value: T } | null>(null);
  const action = useAsyncAction(async (next: T) => {
    setOptimistic({ value: next });
    try {
      await onCommit(next);
    } catch (error) {
      setOptimistic(null);
      throw error;
    }
  });

  // props 值变化（存储已更新或外部修改）后以 props 为准。
  useEffect(() => {
    setOptimistic(null);
  }, [value]);

  return {
    displayValue: optimistic ? optimistic.value : value,
    action,
    commit: (next: T) => void action.run(next),
  };
}

interface InstantFieldProps<T> {
  label: ReactNode;
  description?: ReactNode;
  value: T;
  onCommit: (value: T) => Promise<void>;
  disabled?: boolean;
}

/** 即时保存的开关。 */
export function SettingSwitchField({
  label,
  description,
  value,
  onCommit,
  disabled,
}: InstantFieldProps<boolean>) {
  const id = useId();
  const { displayValue, action, commit } = useInstantCommit(value, onCommit);
  return (
    <SettingRow label={label} description={description} htmlFor={id} state={action.state}>
      <Switch
        id={id}
        checked={displayValue}
        disabled={disabled}
        aria-busy={action.state.status === "pending" || undefined}
        onCheckedChange={commit}
      />
    </SettingRow>
  );
}

export interface SettingSelectOption<T extends string> {
  value: T;
  label: string;
}

/** 即时保存的下拉。 */
export function SettingSelectField<T extends string>({
  label,
  description,
  value,
  options,
  onCommit,
  disabled,
  triggerClassName,
}: InstantFieldProps<T> & {
  options: readonly SettingSelectOption<T>[];
  triggerClassName?: string;
}) {
  const id = useId();
  const { displayValue, action, commit } = useInstantCommit(value, onCommit);
  return (
    <SettingRow label={label} description={description} htmlFor={id} state={action.state}>
      <Select value={displayValue} disabled={disabled} onValueChange={(next) => commit(next as T)}>
        <SelectTrigger id={id} className={cn("min-w-32", triggerClassName)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

/**
 * 异步按钮（交互规范 §7.1）：
 * - 点击后 loading：spinner 替换图标（无图标时覆盖在文字上），宽度不变，执行期间不能重复提交；
 * - 成功：原位 ✓ 1.5 s（`successFeedback="none"` 时交给调用方 toast）；
 * - 失败：原位错误态（红框 + 警示图标 + 自动弹出的错误 tooltip），按钮恢复可点；
 * - `disabledReason`：禁用时通过 tooltip 说明原因；
 * - 图标按钮（size=icon*）保持方形，必须提供 `label`（tooltip 名称 + aria-label）。
 *
 * ```tsx
 * <AsyncButton icon={<RefreshCwIcon />} onClick={() => refreshModels()}>
 *   {intl.formatMessage({ id: "settings.models.refresh" })}
 * </AsyncButton>
 * ```
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { CheckIcon, CircleAlertIcon, LoaderIcon } from "lucide-react";
import { cn } from "../lib/utils.js";
import { Button } from "./button.js";
import { ActionTooltip } from "./action-tooltip.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AsyncActionState } from "@/lib/asyncAction.js";

/** 错误 tooltip 自动展示的时长。 */
const ERROR_TOOLTIP_MS = 4000;

type ButtonProps = React.ComponentProps<typeof Button>;

export interface AsyncButtonProps extends Omit<ButtonProps, "onClick" | "asChild" | "children"> {
  onClick: (event: MouseEvent<HTMLButtonElement>) => Promise<unknown> | unknown;
  children?: ReactNode;
  /** 前置图标；loading / 成功 / 失败时被状态图标原位替换。 */
  icon?: ReactNode;
  /** 动作名称：tooltip 标题与图标按钮的 aria-label。 */
  label?: string;
  /** 已格式化的快捷键 label。 */
  shortcut?: string;
  disabledReason?: string;
  /** `check`（默认）原位 ✓ 1.5 s；`none` 不展示（调用方自行 toast）。 */
  successFeedback?: "check" | "none";
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

function isIconSize(size: ButtonProps["size"]): boolean {
  return typeof size === "string" && size.startsWith("icon");
}

/** 当前状态对应的图标；idle 返回调用方图标。 */
export function resolveAsyncButtonIcon(state: AsyncActionState, icon: ReactNode): ReactNode {
  switch (state.status) {
    case "pending":
      return <LoaderIcon className="animate-spin" aria-hidden="true" />;
    case "success":
      return <CheckIcon className="text-success" aria-hidden="true" />;
    case "error":
      return <CircleAlertIcon className="text-destructive" aria-hidden="true" />;
    case "idle":
      return icon;
  }
}

function useErrorTooltip(state: AsyncActionState) {
  const [open, setOpen] = useState(false);
  const isError = state.status === "error";
  useEffect(() => {
    if (!isError) {
      setOpen(false);
      return undefined;
    }
    setOpen(true);
    const timer = setTimeout(() => setOpen(false), ERROR_TOOLTIP_MS);
    return () => clearTimeout(timer);
  }, [isError, state]);
  return [open, setOpen] as const;
}

export function AsyncButton({
  onClick,
  children,
  icon,
  label,
  shortcut,
  disabled,
  disabledReason,
  successFeedback = "check",
  onSuccess,
  onError,
  className,
  size,
  ...buttonProps
}: AsyncButtonProps) {
  const { intl } = useZCodeIntl();
  const { state: actionState, run } = useAsyncAction(
    (event: MouseEvent<HTMLButtonElement>) => onClick(event),
    { successFeedbackMs: successFeedback === "none" ? 0 : undefined, onSuccess, onError },
  );
  const state: AsyncActionState =
    successFeedback === "none" && actionState.status === "success"
      ? { status: "idle" }
      : actionState;
  const [tooltipOpen, setTooltipOpen] = useErrorTooltip(actionState);
  const pending = state.status === "pending";
  const iconOnly = isIconSize(size);
  const statusIcon = resolveAsyncButtonIcon(state, icon);
  // 无图标的文字按钮：状态图标覆盖在文字上，文字保持占位，宽度不变。
  const overlay = !iconOnly && !icon && (pending || state.status === "success");
  const errorMessage = state.status === "error" ? state.message : undefined;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (pending) {
      event.preventDefault();
      return;
    }
    void run(event);
  };

  return (
    <ActionTooltip
      label={label}
      shortcut={shortcut}
      description={errorMessage}
      disabled={disabled}
      disabledReason={disabledReason}
      open={tooltipOpen}
      onOpenChange={setTooltipOpen}
    >
      <Button
        {...buttonProps}
        size={size}
        disabled={disabled}
        aria-label={iconOnly ? label : buttonProps["aria-label"]}
        aria-busy={pending || undefined}
        aria-disabled={pending || undefined}
        aria-invalid={state.status === "error" || undefined}
        data-async-state={state.status}
        className={cn("relative", className)}
        onClick={handleClick}
      >
        {iconOnly ? statusIcon : null}
        {!iconOnly && icon ? statusIcon : null}
        {iconOnly ? null : <span className={cn(overlay && "invisible")}>{children}</span>}
        {overlay ? (
          <span className="absolute inset-0 flex items-center justify-center">{statusIcon}</span>
        ) : null}
        <span role="status" className="sr-only">
          {state.status === "success"
            ? intl.formatMessage({ id: "ui.asyncAction.succeeded" })
            : (errorMessage ?? "")}
        </span>
      </Button>
    </ActionTooltip>
  );
}

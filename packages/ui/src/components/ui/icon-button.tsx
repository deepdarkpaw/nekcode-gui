/**
 * 纯图标按钮（交互规范 §7.1）：方形尺寸 + tooltip（名称 + 快捷键）+ aria-label；
 * 禁用时 tooltip 说明原因。异步动作请用 AsyncButton（size="icon*" 同样适用）。
 *
 * ```tsx
 * const shortcut = useActionShortcutLabel("app.tools.expand");
 * <IconButton label={intl.formatMessage({ id: "…" })} shortcut={shortcut} onClick={toggle}>
 *   <ChevronsUpDownIcon />
 * </IconButton>
 * ```
 */
import type { ReactNode } from "react";
import { Button } from "./button.js";
import { ActionTooltip } from "./action-tooltip.js";

type ButtonProps = React.ComponentProps<typeof Button>;
type IconButtonSize = "icon" | "icon-xs" | "icon-sm" | "icon-md" | "icon-lg";

export interface IconButtonProps extends Omit<ButtonProps, "size" | "asChild" | "children"> {
  /** 动作名称（tooltip 标题 + aria-label），必填。 */
  label: string;
  children: ReactNode;
  shortcut?: string;
  disabledReason?: string;
  size?: IconButtonSize;
}

export function IconButton({
  label,
  children,
  shortcut,
  disabledReason,
  disabled,
  size = "icon",
  variant = "ghost",
  ...buttonProps
}: IconButtonProps) {
  return (
    <ActionTooltip
      label={label}
      shortcut={shortcut}
      disabled={disabled}
      disabledReason={disabledReason}
    >
      <Button {...buttonProps} variant={variant} size={size} disabled={disabled} aria-label={label}>
        {children}
      </Button>
    </ActionTooltip>
  );
}

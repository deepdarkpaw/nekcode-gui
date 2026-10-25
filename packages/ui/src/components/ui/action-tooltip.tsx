/**
 * 动作 tooltip：名称 + 快捷键，禁用时说明原因（交互规范 §7.1）。
 *
 * 基于 ControlHintTooltip。禁用按钮本身不接收指针事件，因此禁用且有原因时
 * 用一个可聚焦的 span 作为 tooltip 触发器，键盘用户同样能读到原因。
 */
import type { ReactElement, ReactNode } from "react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";

export interface ActionTooltipProps {
  children: ReactElement;
  /** 动作名称。 */
  label?: string;
  /** 已格式化的快捷键 label（见 shortcuts/useActionShortcuts 的 useActionShortcutLabel）。 */
  shortcut?: string;
  /** 补充说明（如失败原因）。 */
  description?: string;
  disabled?: boolean;
  /** 禁用原因；disabled 时显示。 */
  disabledReason?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
}

interface TooltipText {
  title: ReactNode;
  description?: string;
}

/** 组合标题与说明：有名称时说明作为副文；没有名称时说明直接作为标题。 */
export function resolveActionTooltipText(
  label: string | undefined,
  detail: string | undefined,
): TooltipText | null {
  if (label && detail) {
    return { title: label, description: detail };
  }
  const title = label || detail;
  return title ? { title } : null;
}

export function ActionTooltip({
  children,
  label,
  shortcut,
  description,
  disabled = false,
  disabledReason,
  open,
  onOpenChange,
  side,
}: ActionTooltipProps) {
  const reason = disabled ? disabledReason : undefined;
  const text = resolveActionTooltipText(label, reason ?? description);
  if (!text) {
    return children;
  }
  const trigger = reason ? (
    // 禁用按钮的原因必须可被键盘读到，所以触发器 span 可聚焦。
    <span
      tabIndex={0}
      data-slot="disabled-reason-trigger"
      className="inline-flex rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30"
    >
      {children}
    </span>
  ) : (
    children
  );
  return (
    <ControlHintTooltip
      title={text.title}
      description={text.description}
      shortcut={shortcut || undefined}
      open={open}
      onOpenChange={onOpenChange}
      side={side}
    >
      {trigger}
    </ControlHintTooltip>
  );
}

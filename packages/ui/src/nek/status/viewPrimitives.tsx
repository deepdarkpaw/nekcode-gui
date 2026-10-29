import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { StatusActionHandle, StatusMessage } from "./controllerTypes.js";

export function statusMessageText(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  message: StatusMessage,
): string {
  return intl.formatMessage({ id: message.id }, message.values);
}

export function renderStatusMessage(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  message: StatusMessage | undefined,
): string | undefined {
  return message ? statusMessageText(intl, message) : undefined;
}

interface StatusActionButtonProps {
  action: StatusActionHandle;
  label: string;
  actionId: string;
  shortcut?: string;
  ariaLabel?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive" | "warning" | "link";
  size?: "default" | "xs" | "sm" | "lg";
  className?: string;
  children?: ReactNode;
}

export function StatusActionButton({
  action,
  label,
  actionId,
  shortcut,
  ariaLabel,
  variant,
  size = "sm",
  className,
  children,
}: StatusActionButtonProps) {
  const { intl } = useZCodeIntl();
  if (!action.visible) return null;
  const disabled = !action.enabled || action.pending;
  const disabledReason = renderStatusMessage(intl, action.disabledReason);
  const resolvedVariant = variant ?? (action.destructive ? "destructive" : "ghost");
  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-1">
      <ActionTooltip
        label={label}
        shortcut={shortcut}
        description={action.error}
        disabled={disabled}
        disabledReason={disabledReason}
      >
        <Button
          type="button"
          data-status-action={actionId}
          variant={resolvedVariant}
          size={size}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          aria-busy={action.pending || undefined}
          data-primary={action.primary || undefined}
          className={className}
          onClick={(event) => {
            event.stopPropagation();
            void action.run();
          }}
        >
          {action.pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : children}
          <span>{label}</span>
        </Button>
      </ActionTooltip>
      {action.error ? (
        <span role="alert" className="text-ui-sm text-destructive">
          {action.error}
        </span>
      ) : null}
    </span>
  );
}

export function statusToneClass(tone: "neutral" | "success" | "danger" | "muted"): string {
  switch (tone) {
    case "success":
      return "bg-success/15 text-success";
    case "danger":
      return "bg-destructive/15 text-destructive";
    case "muted":
      return "bg-surface text-foreground-subtle";
    case "neutral":
      return "bg-surface text-foreground";
  }
}

export function usageLevelClass(level: "neutral" | "warning" | "danger"): string {
  switch (level) {
    case "warning":
      return "text-warning";
    case "danger":
      return "text-destructive";
    case "neutral":
      return "text-foreground";
  }
}

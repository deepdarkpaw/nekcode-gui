import type { ComponentProps, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ActionHandle } from "./interactionCommon.js";

interface InteractionActionButtonProps extends Omit<
  ComponentProps<typeof Button>,
  "children" | "onClick"
> {
  handle: ActionHandle;
  labelId: string;
  values?: Record<string, string | number>;
  icon?: ReactNode;
}

/** Render one controller action without adding a second interaction state machine. */
export function InteractionActionButton({
  handle,
  labelId,
  values,
  icon,
  ...buttonProps
}: InteractionActionButtonProps) {
  const { intl } = useZCodeIntl();
  if (!handle.visible) return null;

  const label = intl.formatMessage({ id: labelId }, values);
  const disabledReason =
    !handle.enabled && handle.disabledReason
      ? intl.formatMessage(handle.disabledReason)
      : undefined;
  const button = (
    <Button
      {...buttonProps}
      type="button"
      variant={handle.destructive ? "destructive" : handle.primary ? "default" : "outline"}
      disabled={!handle.enabled}
      aria-busy={handle.pending || undefined}
      data-interaction-action={labelId}
      onClick={() => void handle.run()}
    >
      {handle.pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : icon}
      {label}
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      {disabledReason ? (
        <ActionTooltip label={label} disabled disabledReason={disabledReason}>
          {button}
        </ActionTooltip>
      ) : (
        <ActionTooltip label={label}>{button}</ActionTooltip>
      )}
      {handle.error ? (
        <span role="alert" className="text-ui-sm text-[var(--color-danger)]">
          {handle.error}
        </span>
      ) : null}
    </div>
  );
}

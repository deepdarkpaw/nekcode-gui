import type { ReactNode } from "react";
import { LoaderIcon } from "lucide-react";
import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { Button } from "@/components/ui/button.js";
import type { RemoteActionHandle, RemoteMessage } from "./remoteInteraction.js";

export function formatRemoteMessage(
  intl: {
    formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
  },
  value: RemoteMessage | undefined,
): string | undefined {
  return value ? intl.formatMessage({ id: value.id }, value.values) : undefined;
}

export function RemoteActionButton({
  action,
  intl,
  children,
  variant,
  ref,
}: {
  action: RemoteActionHandle;
  intl: {
    formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
  };
  children?: ReactNode;
  variant?: "default" | "outline" | "ghost" | "destructive";
  ref?: (element: HTMLElement | null) => void;
}) {
  if (!action.visible) return null;
  const label = formatRemoteMessage(intl, action.label);
  const disabledReason = formatRemoteMessage(intl, action.disabledReason);
  const button = (
    <Button
      ref={ref}
      type="button"
      variant={
        action.destructive ? "destructive" : (variant ?? (action.primary ? "default" : "outline"))
      }
      disabled={!action.enabled}
      aria-busy={action.pending || undefined}
      aria-invalid={action.error ? true : undefined}
      onClick={() => void action.run()}
    >
      {action.pending ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
      {children ?? label}
    </Button>
  );
  return (
    <ActionTooltip
      label={label}
      disabled={!action.enabled}
      disabledReason={disabledReason}
      description={action.error}
    >
      {button}
    </ActionTooltip>
  );
}

export function RemoteActionError({ action }: { action: RemoteActionHandle }) {
  return action.error ? (
    <p role="alert" className="text-ui-sm text-destructive">
      {action.error}
    </p>
  ) : null;
}

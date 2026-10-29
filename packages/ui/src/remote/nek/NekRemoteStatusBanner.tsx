import { RefreshCwIcon, XIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  RemoteActionButton,
  RemoteActionError,
  formatRemoteMessage,
} from "./RemoteActionButton.js";
import {
  useRemoteConnectionStatusController,
  type RemoteConnectionStatusControllerProps,
} from "./connectionStatusController.js";

export type NekRemoteStatusBannerProps = RemoteConnectionStatusControllerProps;

function toneClass(tone: string): string {
  switch (tone) {
    case "danger":
      return "border-destructive/40 bg-destructive/10 text-destructive-foreground";
    case "warning":
      return "border-warning/40 bg-warning/10 text-warning-foreground";
    case "muted":
      return "border-border bg-surface text-foreground-subtle";
    case "neutral":
      return "border-border bg-surface text-foreground";
    default:
      return "border-border bg-surface text-foreground";
  }
}

export function NekRemoteStatusBanner(props: NekRemoteStatusBannerProps) {
  const { intl } = useZCodeIntl();
  const controller = useRemoteConnectionStatusController(props);
  if (!controller.view.banner) return null;
  return (
    <section
      role="status"
      aria-live="polite"
      className={`fixed top-4 left-1/2 z-40 flex w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border px-3 py-2 shadow-md ${toneClass(controller.view.tone)}`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-ui-base font-medium">
          {formatRemoteMessage(intl, controller.view.message)}
        </p>
        {controller.view.failureMessage ? (
          <p className="mt-1 break-words text-ui-sm">{controller.view.failureMessage}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <RemoteActionButton action={controller.actions.retryNow} intl={intl} ref={undefined}>
          <RefreshCwIcon aria-hidden="true" />
          {formatRemoteMessage(intl, controller.actions.retryNow.label)}
        </RemoteActionButton>
        <RemoteActionButton action={controller.actions.cancel} intl={intl} variant="ghost">
          <XIcon aria-hidden="true" />
          {formatRemoteMessage(intl, controller.actions.cancel.label)}
        </RemoteActionButton>
      </div>
      <RemoteActionError action={controller.actions.retryNow} />
      <RemoteActionError action={controller.actions.cancel} />
    </section>
  );
}

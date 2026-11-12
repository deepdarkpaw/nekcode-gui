import type { TimelineMarkerPayload } from "@zcode/shared/zcode-protocol-v4";
import { AlertTriangleIcon } from "lucide-react";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function ConversationModelError({
  marker,
}: {
  marker: Extract<TimelineMarkerPayload, { type: "modelError" }>;
}) {
  const { intl } = useZCodeIntl();
  const model = [marker.provider, marker.model].filter(Boolean).join("/");
  const status =
    marker.statusCode === undefined
      ? intl.formatMessage({ id: "nek.conversation.modelError.status" })
      : `${marker.statusCode}${marker.statusText ? ` ${marker.statusText}` : ""}`;
  const guidance =
    marker.statusCode === 404
      ? intl.formatMessage({ id: "nek.conversation.modelError.notFoundGuidance" })
      : null;

  return (
    <div
      className="w-full rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-foreground"
      data-model-error="true"
      data-status-code={marker.statusCode}
      role="alert"
    >
      <Fold defaultOpen={false}>
        <FoldTrigger className="w-full gap-2 text-left">
          <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 font-medium text-destructive">
            {intl.formatMessage({ id: "nek.conversation.modelError.title" })}
          </span>
          {model ? <span className="min-w-0 truncate font-mono text-ui-sm">{model}</span> : null}
          <span className="shrink-0 text-ui-sm text-foreground-subtle">{status}</span>
        </FoldTrigger>
        {marker.api || guidance ? (
          <div className="flex flex-col gap-1 pt-2 text-ui-sm text-foreground-subtle">
            {marker.api ? (
              <div>
                {intl.formatMessage({ id: "nek.conversation.modelError.api" }, { api: marker.api })}
              </div>
            ) : null}
            {guidance ? <div>{guidance}</div> : null}
          </div>
        ) : null}
        {marker.rawError ? (
          <FoldContent className="pt-2">
            <pre
              className="max-h-60 overflow-auto select-text whitespace-pre-wrap break-words rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ui-sm text-foreground-subtle"
              data-model-error-raw="true"
            >
              {marker.rawError}
            </pre>
          </FoldContent>
        ) : null}
      </Fold>
    </div>
  );
}

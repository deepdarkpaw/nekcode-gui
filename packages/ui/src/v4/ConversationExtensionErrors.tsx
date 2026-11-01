import type { TimelineMarkerPayload } from "@zcode/shared/zcode-protocol-v4";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Reuse the conversation error banner for the bounded extension-error timeline notice. */
export function ConversationExtensionErrors({
  marker,
}: {
  marker: Extract<TimelineMarkerPayload, { type: "extensionError" }>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col gap-2" role="status">
      {marker.errors.map((error, index) => (
        <ChatErrorBanner
          key={index}
          error={{
            code: "NEK_EXTENSION_ERROR",
            message: intl.formatMessage({ id: "nek.conversation.extensionError" }, error),
            detail: `${error.extensionPath}\n${error.event}\n${error.error}`,
          }}
        />
      ))}
    </div>
  );
}

import type { SessionControl } from "@zcode/shared/zcode-protocol-v4";
import { ChatErrorBanner } from "@/ChatErrorBanner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Explain only the lock facts nek reports; rpc does not identify a particular GUI or terminal. */
export function ConversationLockedBanner({
  readOnly,
  onRetry,
  retrying,
}: {
  readOnly: NonNullable<SessionControl["readOnly"]>;
  onRetry: () => void;
  retrying: boolean;
}) {
  const { intl } = useZCodeIntl();
  const holder = readOnly.holder;
  const detail = holder
    ? intl.formatMessage(
        { id: "nek.conversation.lockHolder" },
        {
          ...holder,
          startedAt: holder.startedAt.replace("T", " ").replace(/\.\d+Z$/u, "Z"),
        },
      )
    : undefined;
  return (
    <ChatErrorBanner
      error={{
        code: "NEK_SESSION_LOCKED",
        message:
          intl.formatMessage({ id: "nek.conversation.readOnlyLocked" }) +
          (detail ? ` ${detail}` : ""),
        ...(detail ? { detail } : {}),
      }}
      onRetry={onRetry}
      retryDisabled={retrying}
      retryLabel={intl.formatMessage({ id: "nek.conversation.retryWritable" })}
    />
  );
}

import { useCallback, useEffect, useMemo } from "react";
import type { IRemoteInteractionHostApi, RemotePromptResponse } from "@zcode/shared/nek-protocol";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createDesktopRemoteInteractionApi } from "@/settings/nek/api/ipcClient.js";
import {
  selectActiveRemotePrompt,
  selectRemotePromptQueueLength,
  subscribeRemotePromptQueue,
  useRemotePromptQueueStore,
} from "./remotePromptQueueStore.js";
import { NekCredentialPromptDialog } from "./NekCredentialPromptDialog.js";
import { NekHostKeyChangedDialog } from "./NekHostKeyChangedDialog.js";
import { NekHostKeyConfirmDialog } from "./NekHostKeyConfirmDialog.js";
import type { ActiveElementInfo } from "./remoteInteraction.js";

export interface NekRemotePromptHostProps {
  api?: IRemoteInteractionHostApi | null;
  activeElement?: ActiveElementInfo;
  onOpenKnownHosts: (connectionId: string) => Promise<void> | void;
  copyFingerprint?: (fingerprint: string) => Promise<void> | void;
}

function PromptDialog({
  item,
  respond,
  removePrompt,
  activeElement,
  onOpenKnownHosts,
  copyFingerprint,
}: {
  item: NonNullable<ReturnType<typeof selectActiveRemotePrompt>>;
  respond: (id: string, response: RemotePromptResponse) => Promise<void>;
  removePrompt: (id: string) => void;
  activeElement?: ActiveElementInfo;
  onOpenKnownHosts: (connectionId: string) => Promise<void> | void;
  copyFingerprint: (fingerprint: string) => Promise<void> | void;
}) {
  switch (item.kind) {
    case "host_key":
      return (
        <NekHostKeyConfirmDialog
          key={item.id}
          open
          prompt={item}
          respond={respond}
          copyFingerprint={copyFingerprint}
          onClose={() => undefined}
          activeElement={activeElement}
        />
      );
    case "host_key_changed":
      return (
        <NekHostKeyChangedDialog
          key={item.id}
          open
          notification={item}
          onOpenKnownHosts={onOpenKnownHosts}
          onClose={() => removePrompt(item.id)}
          activeElement={activeElement}
        />
      );
    case "passphrase":
    case "password":
      return (
        <NekCredentialPromptDialog
          key={item.id}
          open
          prompt={item}
          respond={respond}
          onClose={() => undefined}
          activeElement={activeElement}
        />
      );
  }
}

export function NekRemotePromptHost({
  api: providedApi,
  activeElement,
  onOpenKnownHosts,
  copyFingerprint,
}: NekRemotePromptHostProps) {
  const { intl } = useZCodeIntl();
  const copyToClipboard = useCallback(
    async (value: string) => {
      if (!navigator.clipboard?.writeText) {
        throw new Error(intl.formatMessage({ id: "remote.nek.prompt.clipboardUnavailable" }));
      }
      await navigator.clipboard.writeText(value);
    },
    [intl],
  );
  const api = useMemo(() => providedApi ?? createDesktopRemoteInteractionApi(), [providedApi]);
  const active = useRemotePromptQueueStore(selectActiveRemotePrompt);
  const queueLength = useRemotePromptQueueStore(selectRemotePromptQueueLength);
  const notice = useRemotePromptQueueStore((state) => state.notice);
  const clearNotice = useRemotePromptQueueStore((state) => state.clearNotice);

  useEffect(() => {
    if (!api) return undefined;
    return subscribeRemotePromptQueue(api.onRemotePrompt, (id, response) =>
      api.respondRemotePrompt(id, response),
    );
  }, [api]);

  if (!api) return null;
  return (
    <>
      {notice ? (
        <button
          type="button"
          className="fixed right-4 bottom-4 z-50 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-left text-ui-sm text-warning-foreground shadow-md"
          onClick={clearNotice}
        >
          {intl.formatMessage({ id: notice.id })}
        </button>
      ) : null}
      {active ? (
        <div
          aria-label={
            queueLength > 0
              ? intl.formatMessage({ id: "remote.nek.prompt.queue" }, { count: queueLength })
              : undefined
          }
        >
          <PromptDialog
            item={active}
            respond={(id, response) => useRemotePromptQueueStore.getState().respond(id, response)}
            removePrompt={useRemotePromptQueueStore.getState().removePrompt}
            activeElement={activeElement}
            onOpenKnownHosts={onOpenKnownHosts}
            copyFingerprint={copyFingerprint ?? copyToClipboard}
          />
        </div>
      ) : null}
    </>
  );
}
